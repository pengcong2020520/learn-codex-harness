import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROJECT_ROOT } from '../shared/paths.mjs';
import { clusterNodes } from '../server/modules/config/cluster.mjs';

export { PROJECT_ROOT };
export const isMain = url => process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === url;
export function readEnv(root) { return parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')); }
export function serializeEnv(values) {
  return Object.entries(values).map(([key, value]) => {
    // 单引号同时阻止 Compose 插值；不把输入内容放进错误消息。
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /['\r\n\0]/.test(String(value))) throw new Error(`环境变量 ${key} 含不支持的字符。`);
    return `${key}='${String(value)}'\n`;
  }).join('');
}
export function writeEnv(root, values) {
  const file = path.join(root, '.env'), temporary = `${file}.${randomUUID()}.tmp`;
  const content = serializeEnv(values);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function childEnvironment(env = process.env) {
  // Compose 从 .env 读取配置；宿主的同名变量不能覆盖刚生成的凭据。
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|HOME|USER|LOGNAME|TMPDIR|TEMP|TMP|LANG|LC_.*|TERM|COLORTERM|FORCE_COLOR|NO_COLOR|SSH_AUTH_SOCK|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|COMPOSE_PROJECT_NAME)$/.test(key)));
}
export async function commandRedactor(...environments) {
  // 配置生成器也复用此文件；仅在需要输出时加载服务端脱敏器。
  const { createLogRedactor } = await import('../server/modules/config/index.mjs');
  // 保留宿主与文件中的同名值，避免配置重写期间遗漏旧凭据。
  return createLogRedactor('', environments.flatMap(values => Object.entries(values)
    .filter(([key]) => /KEY|PASSWORD|TOKEN|SECRET|DATABASE_URL|REDIS_URL/i.test(key)).map(([, value]) => value)));
}
export function runProcess(command, args, { root = PROJECT_ROOT, env = childEnvironment(), input, capture = false, output, redact, quiet = false, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd: root, env, stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'] });
    let captured = '', tail = '', settled = false;
    const stream = output && redact?.stream(), errors = output && redact?.stream();
    const emit = text => {
      if (!text) return;
      if (!quiet) output(text);
      else {
        // 只缓存脱敏后的最后 40 行；末尾换行产生的空项不占一行。
        const lines = (tail + text).split('\n');
        tail = lines.slice(-(lines.at(-1) === '' ? 41 : 40)).join('\n');
      }
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      if (stream) emit(stream.end());
      if (errors) emit(errors.end());
      if (error && quiet && tail) output(tail);
      if (error) reject(error); else resolve(captured);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { if (capture) captured += data; if (stream) emit(stream.push(data)); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { if (errors) emit(errors.push(data)); });
    child.on('error', () => finish(new Error('无法运行外部命令，请检查 Docker Compose、Node 与 bash 是否已安装。')));
    child.on('close', code => finish(code === 0 ? null : new Error(`外部命令失败（退出码 ${code ?? '未知'}）；结果待核对，请勿自动重试。`)));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
export function composeUp(env) {
  const nodes = clusterNodes(env);
  return ['compose', ...(nodes.length > 1 ? ['--profile', 'cluster'] : []), 'up', '-d', '--wait',
    ...(nodes.length > 1 ? [...nodes, 'caddy'] : [])];
}
export function accountArgs(root, command, args = [], env = {}) {
  const target = env.CONTAINER_APP_DIR || root;
  return ['compose', 'run', '--rm', '--no-deps', '-T', '-v', `${path.join(root, '.env')}:${target}/.env:ro`, 'node-a', 'node', 'scripts/maintenance.mjs', 'accounts', command, ...args];
}
export function entryUrl(env) {
  const port = env.AGENT_PORT || '4317';
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('AGENT_PORT 必须为 1–65535 的整数。');
  return `http://127.0.0.1:${port}`;
}
export async function checkPort(port = 4317) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('4317 端口不可用，请停止占用端口的服务并检查监听权限。')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
export async function waitReady(env, { fetchImpl = fetch, now = Date.now, wait = sleep, log = console.log } = {}) {
  const deadline = now() + 120_000;
  while (now() < deadline) {
    try {
      const response = await fetchImpl(`${entryUrl(env)}/ready`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (response.status === 200) return;
    } catch { /* 只轮询只读状态，不重发任何修改操作。 */ }
    log('等待服务就绪……');
    await wait(2000);
  }
  throw new Error('等待 /ready 超时；状态待核对，请运行 npm run status。');
}
export function validateUsername(value, variable = 'SETUP_ADMIN_USER') {
  if (!/^[a-z0-9_.-]{1,64}$/.test(value)) throw new Error(`${variable} 须为 1–64 位小写字母、数字、点、下划线或连字符。`);
}
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || /[\r\n\0]/.test(value)) throw new Error('SETUP_ADMIN_PASSWORD 至少 12 位，且不能含换行或空字符。');
}
