import { loadEnvironment } from '../server/modules/config/index.mjs';
import { openDatabase, identity, verifySchema } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser, changeUser } from '../server/modules/accounts/admin.mjs';
import { createPrompts } from '../shared/prompts.mjs';
import { PROJECT_ROOT } from '../shared/paths.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { selectAgentFile } from '../server/modules/agents/selection.mjs';
import { acquireServerLock } from '../server/modules/storage/index.mjs';

const [command, ...args] = process.argv.slice(2);
let pool, prompts, unlock;
try {
  if (!['init', 'add', 'passwd', 'disable', 'list'].includes(command)
    || (['init', 'list'].includes(command) ? args.length : command === 'add' ? args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--admin') : args.length !== 1)
    || args[0]?.startsWith('--')) throw new Error('用法：auth:init | user:add -- <name> [--admin] | user:passwd -- <name> | user:disable -- <name> | user:list；密码只能从 stdin 输入。');
  const env = loadEnvironment();
  if (command === 'init') unlock = acquireServerLock(PROJECT_ROOT);
  pool = await openDatabase(env.DATABASE_URL);
  await verifySchema(pool);
  const legacy = identity(PROJECT_ROOT), store = new AccountStore(pool, legacy.instanceId);
  if (command === 'list') {
    const result = await store.query('SELECT id,username,role,disabled_at,created_at FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL ORDER BY username');
    console.log(JSON.stringify(result.rows, null, 2));
  } else if (command === 'disable') {
    await changeUser(store, args[0], { disable: true });
    console.log('账号已禁用，该用户全部令牌已吊销。');
  } else {
    prompts = createPrompts();
    const username = command === 'init' ? await prompts.ask('用户名：') : args[0];
    const password = await prompts.ask('密码：', { secret: true });
    if (command === 'init') {
      const agent = new AgentDefinition(PROJECT_ROOT, selectAgentFile(PROJECT_ROOT, env.AGENT_DEFINITION));
      await initializeAccounts(store, { ownerId: legacy.ownerId, username, password, workspace: agent.workspacePath });
      console.log('首个 admin 已初始化；旧 owner 与数据归属保留，资料目录已迁移。');
    } else if (command === 'add') {
      await addUser(store, { username, password, admin: args[1] === '--admin', memorySetting: env.AGENT_MEMORY_ENABLED });
      console.log('账号已创建。');
    } else {
      await changeUser(store, username, { password });
      console.log('密码已修改，该用户全部令牌已吊销。');
    }
  }
} catch (error) {
  // 数据库错误 detail 可能包含哈希；只给操作提示。
  console.error(error.code === '23505' ? '用户名已存在。' : error.code ? '账号操作失败，请检查数据库与输入。' : error.message);
  process.exitCode = 1;
} finally { prompts?.close(); await pool?.end(); unlock?.(); }
