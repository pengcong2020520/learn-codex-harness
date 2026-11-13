import { RuntimeStore } from '../server/modules/runtimes/store.mjs';
import { prepareDirectories, isolationMode, prepareServiceDirectories } from '../server/modules/runtimes/directories.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../server/modules/config/index.mjs';
import { openDatabase, identity, verifySchema } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser, changeUser, enabledCount, assertUninitialized } from '../server/modules/accounts/admin.mjs';
import { createPrompts } from '../shared/prompts.mjs';
import { PROJECT_ROOT } from '../shared/paths.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { selectAgentFile } from '../server/modules/agents/selection.mjs';
import { acquireServerLock } from '../server/modules/storage/index.mjs';

export async function accountStatus(store) {
  return await enabledCount(store) > 0 ? 'initialized' : 'uninitialized';
}

export async function runAccounts(argv = process.argv.slice(2), { root = PROJECT_ROOT, connect = openDatabase, env, output = console } = {}) {
  const [command, ...args] = argv;
  // 部署脚本把状态输出当作数据读取，跳过终端格式化并保留可注入的测试输出。
  if (command === 'status' && output === console) output = { log: value => process.stdout.write(`${String(value)}\n`), error: console.error };
  let pool, prompts, unlock;
  try {
    if (!['init', 'add', 'passwd', 'disable', 'list', 'status'].includes(command)
      || (['init', 'list', 'status'].includes(command) ? args.length : command === 'add' ? args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--admin') : args.length !== 1)
      || args[0]?.startsWith('--')) throw new Error('用法：auth:init | user:add -- <name> [--admin] | user:passwd -- <name> | user:disable -- <name> | user:list | accounts.mjs status；密码只能从 stdin 输入。');
    const isolated = isolationMode({ log: () => {} });
    if (command !== 'status') prepareServiceDirectories(root, isolated);
    env ??= loadEnvironment();
    pool = await connect(env.DATABASE_URL, { maintenance: true });
    await verifySchema(pool);
    const legacy = identity(root, { create: command !== 'status' }), store = new AccountStore(pool, legacy.instanceId);
    if (command === 'init') {
      // Repeated init must reject before prompting or taking a running agent's file lock.
      await assertUninitialized(store);
      unlock = acquireServerLock(root);
    }
    if (command === 'status') {
      output.log(await accountStatus(store));
    } else if (command === 'list') {
      const result = await store.query('SELECT id,username,role,disabled_at,created_at FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL ORDER BY username');
      output.log(JSON.stringify(result.rows, null, 2));
    } else if (command === 'disable') {
      await changeUser(store, args[0], { disable: true });
      output.log('账号已禁用，该用户全部令牌已吊销。');
    } else {
      prompts = createPrompts();
      const username = command === 'init' ? await prompts.ask('用户名：') : args[0];
      const password = await prompts.ask('密码：', { secret: true });
      if (command === 'init') {
        const agent = new AgentDefinition(root, selectAgentFile(root, env.AGENT_DEFINITION));
        const user = await initializeAccounts(store, { ownerId: legacy.ownerId, username, password, workspace: agent.workspacePath });
        prepareDirectories(root, await new RuntimeStore(pool, legacy.instanceId, root).ensure(user.id), { isolated, workspace: agent.workspacePath });
        output.log('首个 admin 已初始化；旧 owner 与数据归属保留，资料目录已迁移。');
      } else if (command === 'add') {
        const user = await addUser(store, { username, password, admin: args[1] === '--admin' });
        await new RuntimeStore(pool, legacy.instanceId, root).ensure(user.id);
        output.log('账号已创建。');
      } else {
        await changeUser(store, username, { password });
        output.log('密码已修改，该用户全部令牌已吊销。');
      }
    }
  } catch (error) {
    // 数据库错误 detail 可能包含哈希；只给操作提示。
    output.error(error.code === '23505' ? '用户名已存在。' : error.code ? '账号操作失败，请检查数据库与输入。' : error.message);
    return error.exitCode || 1;
  } finally { prompts?.close(); await pool?.end(); unlock?.(); }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAccounts();
}
