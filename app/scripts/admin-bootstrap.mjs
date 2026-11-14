import { loadEnvironment } from '../server/modules/config/index.mjs';
import { openDatabase, identity, verifySchema } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccountsWithHash } from '../server/modules/accounts/admin.mjs';
import { decodeBootstrap } from '../server/modules/accounts/bootstrap.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { selectAgentFile } from '../server/modules/agents/selection.mjs';
import { PROJECT_ROOT, isMain } from './quickstart-lib.mjs';

export async function bootstrapAdmin(store, encoded, { ownerId, workspace, log = console.log }) {
  if (!encoded) return;
  const credentials = decodeBootstrap(encoded);
  const user = await initializeAccountsWithHash(store, { ...credentials, ownerId, workspace, skipExisting: true });
  log(user ? '已创建引导管理员。' : '已有账号，跳过引导管理员');
  return user;
}
export async function runBootstrap({ root = PROJECT_ROOT, env = loadEnvironment(root), connect = openDatabase, log = console.log, error = console.error } = {}) {
  let pool;
  try {
    if (!env.AGENT_ADMIN_BOOTSTRAP) return 0;
    // 连接前先校验；错误不包含原值、数据库 detail 或哈希。
    decodeBootstrap(env.AGENT_ADMIN_BOOTSTRAP);
    const url = new URL('postgresql://agent@postgres:5432/agent'); url.password = env.AGENT_DB_PASSWORD;
    pool = await connect(url.href, { maintenance: true });
    await verifySchema(pool);
    const legacy = identity(root, { create: false });
    const agent = new AgentDefinition(root, selectAgentFile(root, env.AGENT_DEFINITION));
    await bootstrapAdmin(new AccountStore(pool, legacy.instanceId), env.AGENT_ADMIN_BOOTSTRAP, { ownerId: legacy.ownerId, workspace: agent.workspacePath, log });
    return 0;
  } catch { error('AGENT_ADMIN_BOOTSTRAP 引导失败，请核对格式、数据库与文件权限；内容未显示。'); return 1; }
  finally { await pool?.end(); }
}
if (isMain(import.meta.url)) process.exitCode = await runBootstrap();
