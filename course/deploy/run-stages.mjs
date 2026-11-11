import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export const STAGE_DEFINITIONS = Object.freeze([
  ['s03', 's03-service', 4313], ['s04', 's04-events-messages', 4319],
  ['s05', 's05-agent-assembly', 4323], ['s06', 's06-tools', 4324],
  ['s07', 's07-memory', 4325], ['s08', 's08-data-layer', 4314, 1],
  ['s09', 's09-knowledge-layer', 4315, 2], ['s10', 's10-skill-workflow', 4316, 3],
  ['s11', 's11-model-gateway', 4318, 4],
].map(([id, directory, port, redisDb]) => Object.freeze({ id, directory, port, redisDb })));
export const GATEWAY_FORWARD_PORT = 4331;
export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_FORWARD_PORT}/v1`;

// 部署适配只在这里进行，教学快照仍使用其原有的回环 HTTP 校验。
export async function startGatewayForwarder({ port = GATEWAY_FORWARD_PORT,
  upstreamHost = 'gateway', upstreamPort = 8080, log = message => console.error(message),
  createServer = net.createServer } = {}) {
  const sockets = new Set();
  let stopping = false, stopPromise, resolveDone;
  // 用结果而非拒绝表示退出，避免监听就绪到 supervisor 接管之间产生未处理拒绝。
  const done = new Promise(resolve => { resolveDone = resolve; });
  const server = createServer({ allowHalfOpen: true }, downstream => {
    const upstream = net.createConnection({ host: upstreamHost, port: upstreamPort, allowHalfOpen: true });
    const closePair = () => { downstream.destroy(); upstream.destroy(); };
    for (const [side, socket] of [['client', downstream], ['upstream', upstream]]) {
      sockets.add(socket);
      socket.on('error', error => {
        // 只记录方向和错误码，不记录请求数据或凭据。
        log(`[stages:forwarder] ${side} connection error (${error.code || 'UNKNOWN'}).`);
        closePair();
      });
      socket.once('close', () => {
        sockets.delete(socket);
        // 正常 FIN 允许另一端把已缓冲的响应写完；提前断开则清理整对连接。
        if (!socket.readableEnded || !socket.writableFinished) closePair();
      });
    }
    // 保留字节、背压和半关闭语义，适用于 HTTP/SSE 流式响应。
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  const fatal = error => {
    log(`[stages:forwarder] listener failed (${error.code || 'UNEXPECTED_CLOSE'}).`);
    resolveDone(error);
  };
  server.on('error', fatal);
  server.on('close', () => {
    if (stopping) resolveDone(null);
    else fatal(new Error('Gateway forwarder closed unexpectedly'));
  });
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    stopPromise = new Promise(resolve => server.close(() => { resolveDone(null); resolve(); }));
    return stopPromise;
  };
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { server.removeListener('listening', onReady); reject(error); };
      const onReady = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onReady);
      server.listen(port, '127.0.0.1');
    });
  } catch (error) { await stop(); throw error; }
  console.log(`[stages:forwarder] 127.0.0.1:${server.address().port} -> ${upstreamHost}:${upstreamPort} ready`);
  return { done, stop, address: server.address() };
}

export function selectStages(value = '') {
  const ids = value.trim() ? value.split(',').map(id => id.trim()) : STAGE_DEFINITIONS.map(stage => stage.id);
  if (ids.some(id => !STAGE_DEFINITIONS.some(stage => stage.id === id))) throw new Error('STAGES 只能包含 s03–s11，以逗号分隔。');
  return STAGE_DEFINITIONS.filter(stage => ids.includes(stage.id));
}

// 纯函数：不读取 process.env/文件，不继承部署 .env；registry 仅供 s11 生成非密钥的启用标记。
export function stageEnvironment(id, deployment, { modelEnvironment = {}, providers = [] } = {}, registry = {}) {
  const stage = STAGE_DEFINITIONS.find(item => item.id === id);
  if (!stage) throw new Error('未知阶段');
  if (!deployment.AGENT_GATEWAY_KEY?.trim() || !deployment.CODEX_MODEL?.trim()) throw new Error('缺少 AGENT_GATEWAY_KEY 或 CODEX_MODEL。');
  const env = { PATH: deployment.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', NODE_ENV: 'production',
    AGENT_PORT: String(stage.port), CODEX_MODEL: deployment.CODEX_MODEL,
    CODEX_BASE_URL: GATEWAY_URL, CODEX_API_KEY: deployment.AGENT_GATEWAY_KEY };
  for (const [key, value] of Object.entries({ ...modelEnvironment, ...deployment })) {
    if (/^CODEX_MODEL_[A-Z0-9_]+$/.test(key) && typeof value === 'string' && value !== '') env[key] = value;
  }
  if (stage.redisDb) {
    if (!deployment.AGENT_DB_PASSWORD) throw new Error('缺少 AGENT_DB_PASSWORD。');
    env.DATABASE_URL = `postgresql://agent:${encodeURIComponent(deployment.AGENT_DB_PASSWORD)}@postgres:5432/agent_${id}`;
    env.REDIS_URL = `redis://redis:6379/${stage.redisDb}`;
  }
  if (id === 's11') {
    delete env.CODEX_BASE_URL;
    delete env.CODEX_API_KEY;
    env.AGENT_GATEWAY_URL = GATEWAY_URL;
    env.AGENT_GATEWAY_KEY = deployment.AGENT_GATEWAY_KEY;
    // s11 用 keyEnv/baseUrlEnv 是否非空判定可用性；实际请求统一走 AGENT_GATEWAY_URL。
    // 这些值仅是启用标记，绝不传入真实服务商密钥，也不在阶段内生成网关配置。
    for (const providerId of providers) {
      const provider = registry.providers?.[providerId];
      if (!provider) continue;
      if (provider.keyEnv) env[provider.keyEnv] = 'managed-by-existing-gateway';
      if (provider.baseUrlEnv) env[provider.baseUrlEnv] = GATEWAY_URL;
    }
  }
  return env;
}

// 持久卷里的 PID 属于上一次容器的 PID 命名空间，可能已被别的阶段复用。
// 仅在任何子进程启动之前清理：同一 root 仍有活进程时拒绝启动，权限错误也不猜测。
export function clearObsoleteLock(root, procRoot = '/proc') {
  const lock = path.join(root, '.data/server.lock');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(lock, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('阶段锁文件无效，请先检查。');
  let cwd;
  try { cwd = fs.readlinkSync(path.join(procRoot, String(previous.pid), 'cwd')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (cwd && path.resolve(cwd) === path.resolve(root)) throw new Error('同一阶段已有活进程，拒绝重复启动。');
  fs.unlinkSync(lock);
}

export function restartDelay(failures) { return Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)); }

export async function ensureDatabase(root, databaseUrl) {
  const { Client } = createRequire(path.join(root, 'package.json'))('pg');
  const url = new URL(databaseUrl), name = url.pathname.slice(1);
  if (!/^agent_s(?:08|09|10|11)$/.test(name)) throw new Error('非法阶段数据库名。');
  url.pathname = '/agent';
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  try {
    await client.connect();
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!found.rowCount) {
      try { await client.query(`CREATE DATABASE "${name}"`); }
      catch (error) { if (error.code !== '42P04') throw error; }
    }
  } finally { await client.end(); }
}

// 每个任务使用独立进程组；退出后清理遗留的 Codex/npm 后代，防止占用锁或端口。
export function startCommand(command, args, { cwd, env, id }, spawnChild = spawn) {
  const child = spawnChild(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const secrets = [env.CODEX_API_KEY, env.AGENT_GATEWAY_KEY, env.DATABASE_URL,
    env.DATABASE_URL && decodeURIComponent(new URL(env.DATABASE_URL).password)].filter(Boolean);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      for (const secret of secrets) line = line.split(secret).join('[REDACTED]');
      console.log(`[${id}] ${line}`);
    });
  }
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let finished = false;
  // exit 而非 close：遗留后代可能仍持有 stdout，必须先清理它们才能收到 close。
  const done = new Promise(resolve => {
    child.once('error', () => { finished = true; resolve({ code: 1 }); });
    child.once('exit', (code, signal) => {
      finished = true;
      signalGroup('SIGKILL');
      resolve({ code, signal });
    });
  });
  return { done, async stop() {
    if (finished) return;
    // 先让服务自己关闭 HTTP、队列和 Codex；npm 任务则向整个进程组发信号。
    if (command === 'npm') signalGroup('SIGTERM'); else child.kill('SIGTERM');
    let timer;
    await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => { signalGroup('SIGKILL'); resolve(); }, 10_000); })]);
    clearTimeout(timer);
    await done;
  } };
}

export function superviseStage(stage, root, env, { start = startCommand, sleep = delay, now = Date.now } = {}) {
  let stopping = false, active, failures = 0;
  const controller = new AbortController();
  const options = { cwd: root, env, id: stage.id };
  async function run(command, args) {
    if (stopping) throw new Error('stopping');
    active = start(command, args, options);
    const result = await active.done;
    active = undefined;
    if (result.code !== 0) throw new Error('子进程退出');
  }
  const done = (async () => {
    while (!stopping) {
      const started = now();
      try {
        if (stage.redisDb) {
          await run(process.execPath, [fileURLToPath(import.meta.url), '--database', root]);
          await run('npm', ['run', 'data:migrate']);
        }
        // agent:init 只创建缺失资料目录且不覆盖文件，每次启动都执行，不与 knowledge:init 共用标记。
        if (stage.id === 's10' || stage.id === 's11') await run('npm', ['run', 'agent:init']);
        if (['s09', 's10', 's11'].includes(stage.id)) {
          const marker = path.join(root, 'workspace/.stages-knowledge-initialized');
          if (!fs.existsSync(marker)) {
            await run('npm', ['run', 'knowledge:init']);
            if (!stopping) fs.writeFileSync(marker, 'v1\n', { mode: 0o600 });
          }
        }
        await run(process.execPath, ['server/main.mjs']);
      } catch {
        // 子进程 stderr 已加前缀并脱敏；不打印可能含连接凭据的异常对象。
      }
      if (stopping) break;
      if (now() - started >= 60_000) failures = 0;
      const wait = restartDelay(failures++);
      console.error(`[${stage.id}] 进程退出或初始化失败，${wait / 1000}s 后重试。`);
      await sleep(wait, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  })();
  return { done, async stop() {
    stopping = true;
    controller.abort();
    await active?.stop();
    await done;
  }, preventRestart() { stopping = true; controller.abort(); } };
}

export async function checkHealth(stages, stagesRoot, fetchHealth = fetch) {
  let ready = true;
  await Promise.all(stages.map(async stage => {
    try {
      const { url, token } = JSON.parse(fs.readFileSync(path.join(stagesRoot, stage.directory, '.data/connection.json'), 'utf8'));
      if (url !== `http://127.0.0.1:${stage.port}` || typeof token !== 'string' || token.length < 16) throw new Error('invalid connection');
      const response = await fetchHealth(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      const health = await response.json();
      if (!response.ok || health.status !== 'ready') throw new Error('not ready');
      console.log(`[${stage.id}] ready (${stage.port})`);
    } catch { ready = false; console.log(`[${stage.id}] not ready (${stage.port})`); }
  }));
  return ready;
}

// 转发监听先就绪；监听器故障使 main 拒绝并以非零状态退出，由 Compose 重启。
export async function runStageServices(settings, stagesRoot, {
  startForwarder = startGatewayForwarder, supervise = superviseStage, signals = process,
} = {}) {
  const managers = [];
  let forwarder, stopping = false, requestStop;
  const stopped = new Promise(resolve => { requestStop = () => { stopping = true; resolve(); }; });
  signals.on('SIGTERM', requestStop);
  signals.on('SIGINT', requestStop);
  try {
    forwarder = await startForwarder();
    if (stopping) return;
    for (const { stage, env } of settings) {
      managers.push(supervise(stage, path.join(stagesRoot, stage.directory), env));
    }
    await Promise.race([
      forwarder.done.then(error => { throw error || new Error('Gateway forwarder stopped unexpectedly'); }),
      Promise.all(managers.map(manager => manager.done)),
      stopped,
    ]);
  } finally {
    const errors = [];
    try {
      for (const manager of managers) manager.preventRestart();
      for (const manager of [...managers].reverse()) {
        try { await manager.stop(); } catch (error) { errors.push(error); }
      }
    } finally {
      try { await forwarder?.stop(); } finally {
        signals.removeListener('SIGTERM', requestStop);
        signals.removeListener('SIGINT', requestStop);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Stage shutdown failed');
  }
}

export async function main() {
  if (process.argv[2] === '--database') {
    await ensureDatabase(process.argv[3], process.env.DATABASE_URL);
    return;
  }
  const stages = selectStages(process.env.STAGES);
  const stagesRoot = path.resolve(process.env.CONTAINER_STAGES_DIR || '/stages');
  if (process.argv[2] === '--health') {
    process.exitCode = await checkHealth(stages, stagesRoot) ? 0 : 1;
    return;
  }
  const config = JSON.parse(fs.readFileSync('/etc/stages/config.json', 'utf8'));
  const registry = stages.some(stage => stage.id === 's11')
    ? JSON.parse(fs.readFileSync(path.join(stagesRoot, 's11-model-gateway/config/models.json'), 'utf8')) : {};
  // 先验证全部配置，再启动；不留下配置错误下的半套服务。
  const settings = stages.map(stage => ({ stage, env: stageEnvironment(stage.id, process.env, config, registry) }));
  for (const { stage } of settings) clearObsoleteLock(path.join(stagesRoot, stage.directory));
  await runStageServices(settings, stagesRoot);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('[stages] 启动或运行失败，请检查配置文件、目录权限及带阶段前缀的日志。'); process.exitCode = 1; });
}
