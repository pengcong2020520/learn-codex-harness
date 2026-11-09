import { rowFenceDetail, logFailure } from '../data/diagnostics.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentIdentity } from '../accounts/context.mjs';
export const shardContext = new AsyncLocalStorage();
export const shardUser = () => shardContext.getStore()?.userId || currentIdentity()?.userId;
export const withShardUser = (userId, operation) => shardContext.run({ userId }, operation);
export async function shardFailure(error, generation, origin, statement) {
  if (error.code !== 'SH001' || error.shardDiagnostic) return;
  // The rejected ROW is authoritative. Requester identity alone cannot identify its shard.
  const row = rowFenceDetail(error), owner = row.ownerId;
  let before, after, refreshFailed = false;
  try { before = owner && generation.routes?.routeOf(owner); } catch {}
  try { await generation.routes?.refresh(); after = owner && generation.routes?.routeOf(owner); }
  catch { refreshFailed = true; }
  const believedPrimary = before?.primary === generation.nodeId;
  const isolate = believedPrimary && (refreshFailed || after?.primary === generation.nodeId);
  error.shardDiagnostic = { ownerId: owner || null, believedPrimary, refreshFailed, isolate };
  logFailure(error, generation, origin, statement, 'SH001', {
    classification: isolate ? 'stale-primary' : believedPrimary ? 'ownership-moved' : owner ? 'wrong-shard-write' : 'unknown-row-owner',
    rowRouteBefore: before || null, rowRouteAfter: after || null, ...error.shardDiagnostic,
  });
  // Do not await process shutdown inside a rejected SQL call: rollback and RPC drain may depend on it.
  if (owner && after && after.primary !== generation.nodeId && !refreshFailed) {
    void generation.stopShard?.(after?.shardId || before?.shardId)?.catch(error => generation.log?.(`分片进程停止失败：${error.message}`));
  }
  if (isolate) generation.isolate?.(refreshFailed ? 'shard-refresh-failed' : 'database-stale-shard');
}
export async function setShard(client, generation) {
  generation.assert();
  const user = shardUser(), route = user && generation.routes.routeOf(user);
  await client.query("SELECT set_config('app.node',$1,true),set_config('app.shard_epoch',$2,true)",
    [generation.nodeId, route ? String(route.epoch ?? '') : '']);
}
