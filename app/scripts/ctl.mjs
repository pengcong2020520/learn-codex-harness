import fs from 'node:fs';
import path from 'node:path';
import { createPrompts } from '../shared/prompts.mjs';
import { loadEnvironment } from '../server/modules/config/index.mjs';
import { PROJECT_ROOT, isMain, readEnv, childEnvironment, commandRedactor, runProcess, composeUp, accountArgs, entryUrl, waitReady, validateUsername, validatePassword } from './quickstart-lib.mjs';

export function ctlArgs(command, args, env, root) {
  if (command === 'up' && !args.length) return composeUp(env);
  if (command === 'down' && !args.length) return ['compose', 'stop'];
  if (command === 'status' && !args.length) return ['compose', 'ps'];
  if (command === 'logs' && args.every(arg => /^[a-z][a-z0-9-]*$/.test(arg))) return ['compose', 'logs', '-f', '--tail', '100', ...args];
  if (['init', 'add', 'passwd', 'disable', 'list'].includes(command)) {
    if (['init', 'list'].includes(command) ? args.length : command === 'add' ? args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--admin') : args.length !== 1)
      throw new Error('账号参数无效；使用 user:add -- <name> [--admin]、user:passwd -- <name>、user:disable -- <name> 或 user:list。');
    if (args[0]) validateUsername(args[0], '用户名');
    return accountArgs(root, command, args, env);
  }
  throw new Error('命令或参数无效；使用 up、down、logs [服务名]、status 或账号命令。');
}
export async function ctl(argv = process.argv.slice(2), { root = PROJECT_ROOT, env = process.env, run = runProcess, ready = waitReady, fetchImpl = fetch, prompts, log = console.log, output = text => process.stdout.write(text) } = {}) {
  const [command, ...raw] = argv, development = raw.includes('--dev'), quiet = command === 'up' && raw.includes('--quiet'), args = raw.filter(arg => arg !== '--dev' && !(quiet && arg === '--quiet'));
  if (raw.filter(arg => arg === '--quiet').length > 1) throw new Error('--quiet 不能重复指定。');
  if (development) {
    if (!['init', 'add', 'passwd', 'disable', 'list'].includes(command)) throw new Error('--dev 只适用于账号命令。');
    ctlArgs(command, args, {}, root);
    // 开发模式沿用原脚本的认证与数据库配置；仍由原脚本隐藏输入。
    const { runAccounts } = await import('./accounts.mjs');
    const code = await runAccounts([command, ...args], { root, env: loadEnvironment(root, env) });
    if (code) throw new Error('开发模式账号操作失败，请检查 DATABASE_URL 与输入。');
    return;
  }
  const values = readEnv(root), dockerArgs = ctlArgs(command, args, values, root);
  const redact = await commandRedactor(env, values);
  let input;
  if (['init', 'add', 'passwd'].includes(command)) {
    prompts ??= createPrompts();
    try {
      const username = command === 'init' ? (await prompts.ask('管理员用户名 [admin]：')).trim() || 'admin' : args[0];
      validateUsername(username);
      const password = await prompts.ask('密码（至少 12 位）：', { secret: true });
      validatePassword(password);
      if (password !== await prompts.ask('再次输入密码：', { secret: true })) throw new Error('两次密码不一致。');
      input = `${command === 'init' ? `${username}\n` : ''}${password}\n`;
    } finally { prompts.close(); }
  }
  if (command === 'up') {
    log('构建镜像并准备数据目录……');
    await run('bash', ['deploy/configure.sh'], { root, env: childEnvironment(env), output, redact, quiet });
    log('启动服务……');
  }
  const result = await run('docker', dockerArgs, { root, env: childEnvironment(env), input, capture: !['logs', 'up'].includes(command),
    ...(['logs', 'up'].includes(command) ? { output, redact, quiet } : {}) });
  if (result) log(redact(result));
  if (command === 'up') await ready(values, { log });
  if (command === 'status') {
    const version = fs.existsSync(path.join(root, 'REVISION')) ? fs.readFileSync(path.join(root, 'REVISION'), 'utf8').trim() : JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
    log(`版本：${redact(version)}`);
    try {
      const response = await fetchImpl(`${entryUrl(values)}/ready`, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      const body = await response.json();
      log(redact(JSON.stringify({ http: response.status, status: body.status, version: body.version ?? null, waiting: body.waiting ?? null, replication: body.replication ?? null })));
    } catch { throw new Error('/ready 不可达，请检查容器状态。'); }
  }
}
if (isMain(import.meta.url)) ctl().catch(error => { console.error(error.code ? '操作失败，请检查 .env 与文件权限；内容未显示。' : error.message); process.exitCode = 1; });
