import { createLogRedactor } from '../server/modules/config/index.mjs';
import { PROJECT_ROOT, isMain, readEnv, childEnvironment, runProcess } from './quickstart-lib.mjs';

export function parseDeploy(argv, env = {}) {
  const args = [...argv];
  let host = env.DEPLOY_HOST;
  const index = args.indexOf('--host');
  if (index !== -1) { host = args[index + 1]; args.splice(index, 2); }
  if (!host || !/^[a-zA-Z0-9_@.-]+$/.test(host) || host.startsWith('-')) throw new Error('请用 --host 指定有效 SSH 目标，例如 root@example.com。');
  const directory = env.APP_DIR || '/opt/codex-agent';
  if (!/^\/[a-zA-Z0-9_/-]+$/.test(directory) || directory === '/' || directory.includes('..')) throw new Error('APP_DIR 必须是无空格的绝对部署路径。');
  if (args.length && !['check', 'init-env', 'deploy', 'auth-init', 'user', 'status', 'tunnel', 'backup', 'backup-download', 'rollback'].includes(args[0])) throw new Error('不支持此部署子命令，请使用 status、tunnel、backup、rollback 或 user -- add <name>。');
  return { host, directory, args };
}
export async function deploy(argv = process.argv.slice(2), { root = PROJECT_ROOT, env = process.env, run = runProcess, log = console.log, output = text => process.stdout.write(text) } = {}) {
  const { host, directory, args } = parseDeploy(argv, env);
  const childEnv = { ...childEnvironment(env), DEPLOY_HOST: host, APP_DIR: directory };
  let values = {};
  try { values = readEnv(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const redact = createLogRedactor('', Object.entries(values).filter(([key]) => /KEY|PASSWORD|TOKEN|SECRET/.test(key)).map(([, value]) => value));
  const remote = command => run('bash', ['deploy/remote.sh', ...command], { root, env: childEnv, output, redact });
  if (args.length) return remote(args);
  log('检查服务器部署条件……');
  await remote(['check']);
  const exists = await run('ssh', ['-o', 'BatchMode=yes', host, `if test -f '${directory}/.env'; then printf configured; else printf missing; fi`], { root, env: childEnv, capture: true });
  if (exists === 'missing') await remote(['init-env']);
  else if (exists !== 'configured') throw new Error('无法确定服务器 .env 是否存在；未继续部署。');
  else log('服务器已有 .env，保留现有配置。');
  await remote(['deploy']);
  const status = await run('ssh', ['-o', 'BatchMode=yes', host, `cd '${directory}' && bash deploy/env-run.sh -T node-a node scripts/maintenance.mjs accounts status`], { root, env: childEnv, capture: true });
  if (status.trim() === 'uninitialized') log(`账号尚未初始化，请运行 npm run deploy -- --host ${host} auth-init。`);
  else if (status.trim() === 'initialized') log('部署完成，账号已初始化；可运行 deploy 的 status 或 tunnel 子命令。');
  else throw new Error('无法确定账号初始化状态；请人工核对。');
}
if (isMain(import.meta.url)) deploy().catch(error => { console.error(error.code ? '部署失败，请检查本机配置；未自动重试。' : error.message); process.exitCode = 1; });
