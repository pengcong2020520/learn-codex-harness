import { AsyncLocalStorage } from 'node:async_hooks';
import { currentIdentity } from '../accounts/context.mjs';
export const shardContext = new AsyncLocalStorage();
export const shardUser = () => shardContext.getStore()?.userId || currentIdentity()?.userId;
export const withShardUser = (userId, operation) => shardContext.run({ userId }, operation);
export async function shardFailure(error, generation, origin, statement) {
  if (error.code !== 'SH001' || error.shardDiagnostic) return;
  const userId = shardUser();
  error.shardDiagnostic = { userId, nodeId: generation.nodeId, statement, stack: origin.stack };
  try {
    await generation.routes.refresh();
    if (!userId || generation.routes.routeOf(userId).primary === generation.nodeId) {
      try { (generation.log || console.error)(`[SH001] 本地仍认为自己是主；停止写入。\n${origin.stack}`); }
      finally { generation.isolate('database-stale-shard'); }
    }
  } catch { generation.isolate('shard-refresh-failed'); }
}
export async function setShard(client, generation) {
  generation.assert();
  const user = shardUser(), route = user && generation.routes.routeOf(user);
  await client.query("SELECT set_config('app.node',$1,true),set_config('app.shard_epoch',$2,true)",
    [generation.nodeId, route ? String(route.epoch ?? '') : '']);
}
