import { ensurePreviewSecret } from './ensure-preview-secret.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createPrompts } from '../shared/prompts.mjs';
import { loadEnvironment } from '../server/modules/config/index.mjs';
import { PROJECT_ROOT, isMain, readEnv, childEnvironment, commandRedactor, runProcess, composeUp, accountArgs, entryUrl, waitReady, validateUsername, validatePassword, checkRuntimeEnvironment, checkDocker } from './quickstart-lib.mjs';

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
async function accountInput(command, args, prompts, log) {
  prompts ??= createPrompts();
  try {
    const username = command === 'init' ? (await prompts.ask('管理员用户名 [admin]：')).trim() || 'admin' : args[0];
    validateUsername(username, '用户名');
    for (let attempt = 0; attempt < 3; attempt++) {
      // 与 setup 一致，每次重输整组；取消或读取失败不重问。
      const password = await prompts.ask('密码（至少 12 位）：', { secret: true });
      const confirmation = await prompts.ask('再次输入密码：', { secret: true });
      try {
        validatePassword(password, '密码');
        if (password !== confirmation) throw new Error('两次密码不一致。');
        return `${command === 'init' ? `${username}\n` : ''}${password}\n`;
      } catch (error) { log(error.message); }
    }
    throw new Error('已连续 3 次输入无效，账号未修改；请重新运行当前命令。');
  } finally { prompts.close(); }
}
export async function ctl(argv = process.argv.slice(2), { root = PROJECT_ROOT, env = process.env, platform = process.platform, procVersion, run = runProcess, ready = waitReady, fetchImpl = fetch, prompts, isTTY = Boolean(process.stdin.isTTY), log = console.log, output = text => process.stdout.write(text) } = {}) {
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
  checkRuntimeEnvironment({ platform, procVersion, root });
  let values = readEnv(root);
  const dockerArgs = ctlArgs(command, args, values, root);
  if (command === 'up') values = ensurePreviewSecret(root);
  const redact = await commandRedactor(env, values);
  const input = ['init', 'add', 'passwd'].includes(command) ? await accountInput(command, args, prompts, log) : undefined;
  if (command === 'up') {
    log('检查 Docker Compose 与 Docker 运行状态……');
    await checkDocker({ platform, root, env, run });
    log('构建镜像并准备数据目录……');
    await run('bash', ['deploy/configure.sh'], { root, env: childEnvironment(env), output, redact, quiet });
    log('启动服务……');
  }
  const result = await run('docker', dockerArgs, { root, env: childEnvironment(env), input, capture: !['logs', 'up'].includes(command),
    ...(['logs', 'up'].includes(command) ? { output, redact, quiet } : {}) });
  if (result) log(redact(result));
  if (command === 'up') {
    let status;
    try {
      status = (await run('docker', accountArgs(root, 'status', [], values), { root, env: childEnvironment(env), capture: true })).trim();
    } catch { throw new Error('无法确认账号状态，请运行 npm run status 核对；请勿自动重试。'); }
    if (!['initialized', 'uninitialized'].includes(status)) throw new Error('账号状态无法识别，请运行 npm run status 核对；请勿自动重试。');
    if (status === 'uninitialized') {
      if (!isTTY) throw new Error('还没有管理员账号，非交互终端无法创建；请运行 npm run auth:init，或通过 SETUP_ADMIN_USER、SETUP_ADMIN_PASSWORD 环境变量运行 npm run setup -- --non-interactive 初始化。');
      log('还没有管理员账号，现在创建');
      const input = await accountInput('init', [], prompts, log);
      const result = await run('docker', accountArgs(root, 'init', [], values), { root, env: childEnvironment(env), input, capture: true });
      if (result) log(redact(result));
    }
    await ready(values, { log });
  }
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
