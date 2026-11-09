import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GATEWAY_FORWARD_PORT, GATEWAY_URL, startGatewayForwarder, runStageServices, STAGE_DEFINITIONS, stageEnvironment, selectStages, restartDelay, superviseStage, checkHealth, clearObsoleteLock, startCommand, ensureDatabase } from '../deploy/run-stages.mjs';
import { deploymentConfig } from '../deploy/stages-config.mjs';
import { deployable } from '../deploy/package-deploy.mjs';

const app = path.resolve(import.meta.dirname, '..'), repo = path.dirname(app);
const registry = JSON.parse(fs.readFileSync(path.join(repo, 'stages/s11-model-gateway/config/models.json')));
const deployment = { AGENT_GATEWAY_KEY: 'sk-bf-test-only', AGENT_DB_PASSWORD: 'test@:/#% password',
  CODEX_MODEL: 'kimi/kimi-k2.7-code', CODEX_MODEL_CONTEXT_WINDOW: '200000',
  KIMI_API_KEY: 'provider-secret-must-not-pass', OPENAI_API_KEY: 'other-secret',
  AGENT_PORT: '9000', DATABASE_URL: 'invalid', REDIS_URL: 'invalid', NODE_OPTIONS: '--inspect',
  AGENT_BUDGET_DAILY_TOKENS: '0', HOME: '/untrusted', UNRELATED_SECRET: 'private' };
const filtered = deploymentConfig(deployment, registry);
function temporary(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stages-deploy-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('阶段环境：固定端口、白名单、数据库及 Redis 隔离、密码 URL 编码', () => {
  const before = structuredClone(deployment);
  const ports = ['4313', '4319', '4323', '4324', '4325', '4314', '4315', '4316', '4318'];
  for (const [index, stage] of STAGE_DEFINITIONS.entries()) {
    const env = stageEnvironment(stage.id, deployment, filtered, registry);
    assert.equal(env.AGENT_PORT, ports[index]);
    assert.equal(env.CODEX_MODEL, deployment.CODEX_MODEL);
    assert.equal(env.CODEX_MODEL_CONTEXT_WINDOW, '200000');
    assert.equal(env.HOME, '/home/node');
    for (const key of ['AGENT_DB_PASSWORD', 'UNRELATED_SECRET', 'NODE_OPTIONS', 'AGENT_BUDGET_DAILY_TOKENS', 'STAGES']) assert.ok(!(key in env));
    assert.ok(!JSON.stringify(env).includes(deployment.KIMI_API_KEY));
    assert.ok(!JSON.stringify(env).includes(deployment.OPENAI_API_KEY));
    if (index < 8) {
      assert.equal(env.CODEX_BASE_URL, 'http://127.0.0.1:4331/v1');
      assert.equal(env.CODEX_API_KEY, deployment.AGENT_GATEWAY_KEY);
      assert.ok(!('AGENT_GATEWAY_KEY' in env));
      assert.ok(!('KIMI_API_KEY' in env));
    }
    if (index >= 5) {
      const url = new URL(env.DATABASE_URL);
      assert.equal(decodeURIComponent(url.password), deployment.AGENT_DB_PASSWORD);
      assert.equal(url.pathname, `/agent_${stage.id}`);
      assert.equal(url.hostname, 'postgres');
      assert.equal(env.REDIS_URL, `redis://redis:6379/${index - 4}`);
    } else assert.ok(!('DATABASE_URL' in env) && !('REDIS_URL' in env));
  }
  assert.deepEqual(deployment, before);
  assert.throws(() => stageEnvironment('s12', deployment));
  assert.throws(() => stageEnvironment('s08', { ...deployment, AGENT_DB_PASSWORD: '' }));
  assert.throws(() => stageEnvironment('s03', { ...deployment, AGENT_GATEWAY_KEY: '' }));
});

// s12–s18 自带独立 Compose 与数据卷，不进入共享 stages 容器。
for (const id of ['s12', 's13', 's14', 's15', 's16', 's17', 's18']) test(`${id} 自带完整部署，显式排除共享 stages 容器`, () => {
  assert.ok(!STAGE_DEFINITIONS.some(stage => stage.id === id));
  for (const relative of ['compose.yaml', 'deploy/run-stages.mjs', 'deploy/stages.Dockerfile', 'deploy/stages.Dockerfile.dockerignore', 'deploy/server-setup.sh']) {
    assert.doesNotMatch(fs.readFileSync(path.join(app, relative), 'utf8'), new RegExp({ s12: 's12-deploy', s13: 's13-auth', s14: 's14-isolation', s15: 's15-hub', s16: 's16-coordination', s17: 's17-sharding', s18: 's18-replication' }[id]));
  }
  assert.throws(() => selectStages(id));
});

test('模型透传文件只含 CODEX_MODEL_* 和启用 ID；支持未来模型参数', () => {
  const config = deploymentConfig({ ...deployment, CODEX_MODEL_FUTURE_OPTION: 'new-value', CODEX_MODEL_EMPTY: '' }, registry);
  assert.equal(config.modelEnvironment.CODEX_MODEL_FUTURE_OPTION, 'new-value');
  assert.ok(!('CODEX_MODEL_EMPTY' in config.modelEnvironment));
  assert.deepEqual(config.providers.sort(), ['kimi', 'openai']);
  assert.doesNotMatch(JSON.stringify(config), /provider-secret|other-secret|password|UNRELATED/);
  const env = stageEnvironment('s03', deployment, config);
  assert.equal(env.CODEX_MODEL_FUTURE_OPTION, 'new-value');
});

test('s11 使用真实启动配置解析：已有网关、启用标记、无直连冲突、预算默认值', async () => {
  const { buildAppServerLaunch } = await import('../../stages/s11-model-gateway/server/modules/codex/launch.mjs');
  const { budgetConfig } = await import('../../stages/s11-model-gateway/server/modules/usage/config.mjs');
  const env = stageEnvironment('s11', deployment, filtered, registry);
  assert.equal(env.AGENT_GATEWAY_URL, 'http://127.0.0.1:4331/v1');
  assert.equal(env.AGENT_GATEWAY_KEY, deployment.AGENT_GATEWAY_KEY);
  assert.equal(env.KIMI_API_KEY, 'managed-by-existing-gateway');
  assert.ok(!('CODEX_BASE_URL' in env) && !('CODEX_API_KEY' in env));
  const launch = buildAppServerLaunch(env, '', { registry });
  assert.equal(launch.gateway, true);
  assert.equal(launch.model, deployment.CODEX_MODEL);
  assert.equal(launch.baseUrl, env.AGENT_GATEWAY_URL);
  assert.equal(launch.env.CODEX_API_KEY, deployment.AGENT_GATEWAY_KEY);
  assert.ok(!('KIMI_API_KEY' in launch.env));
  assert.equal(budgetConfig(env).dailyTokens, null);
  assert.equal(budgetConfig(env).downgradeAt, null);
  assert.throws(() => buildAppServerLaunch(stageEnvironment('s11', deployment, { providers: [] }, registry), '', { registry }), /没有可用/);
});

test('s03–s10 原始教学启动校验允许回环转发地址，拒绝直接连接 compose 网关', async () => {
  for (const stage of STAGE_DEFINITIONS.slice(0, -1)) {
    const { buildAppServerLaunch } = await import(pathToFileURL(path.join(repo, 'stages', stage.directory, 'server/modules/codex/launch.mjs')));
    const env = stageEnvironment(stage.id, deployment, filtered);
    assert.equal(buildAppServerLaunch(env).baseUrl, 'http://127.0.0.1:4331/v1');
    for (const baseUrl of ['http://gateway:8080/v1', 'http://example.test/v1', 'http://gateway:9999/v1', 'http://gateway:8080/other', 'http://gateway:8080/v1?key=bad']) {
      assert.throws(() => buildAppServerLaunch({ ...env, CODEX_BASE_URL: baseUrl }));
    }
  }
});

test('STAGES 严格校验、去重并保持固定顺序；重试有上限', () => {
  assert.equal(selectStages().length, 9);
  assert.deepEqual(selectStages('s05,s03, s05').map(stage => stage.id), ['s03', 's05']);
  for (const input of ['s01', 's03,', 's03,s12']) assert.throws(() => selectStages(input));
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(restartDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('supervisor 初始化失败后退避，不启动服务；正常启动先迁移、knowledge:init 仅一次，停止不再重启', async t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'workspace'));
  const stage = STAGE_DEFINITIONS.find(stage => stage.id === 's09');
  const calls = [], sleeps = [];
  let failMigration = true, finishService, reachedService;
  const serviceStarted = new Promise(resolve => { reachedService = resolve; });
  const start = (command, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'server/main.mjs') {
      const done = new Promise(resolve => { finishService = resolve; });
      reachedService();
      return { done, stop: async () => finishService({ code: 0 }) };
    }
    const fail = args.includes('data:migrate') && failMigration;
    if (fail) failMigration = false;
    return { done: Promise.resolve({ code: fail ? 1 : 0 }), stop: async () => {} };
  };
  const manager = superviseStage(stage, root, {}, { start, sleep: async ms => { sleeps.push(ms); } });
  await serviceStarted;
  assert.equal(calls.filter(call => call === 'run data:migrate').length, 2);
  assert.equal(calls.filter(call => call === 'run knowledge:init').length, 1);
  assert.equal(calls.at(-1), 'server/main.mjs');
  assert.deepEqual(sleeps, [1000]);
  await manager.stop();
  const count = calls.length;
  await manager.done;
  assert.equal(calls.length, count);
  // 新一次容器启动仍迁移，但 marker 保留后不重复安装 knowledge skill。
  const secondCalls = [];
  let reachedSecond;
  const secondStarted = new Promise(resolve => { reachedSecond = resolve; });
  const second = superviseStage(stage, root, {}, { start: (cmd, args) => {
    secondCalls.push(args.join(' '));
    const task = start(cmd, args);
    if (args[0] === 'server/main.mjs') reachedSecond();
    return task;
  } });
  await secondStarted;
  await second.stop();
  assert.ok(secondCalls.includes('run data:migrate'));
  assert.ok(!secondCalls.includes('run knowledge:init'));
});

test('s10、s11 的初始化包含 agent:init 且位于服务启动之前；其他阶段不包含', async t => {
  async function boot(stage, root) {
    const calls = [];
    let finishService, reached;
    const serviceStarted = new Promise(resolve => { reached = resolve; });
    const manager = superviseStage(stage, root, {}, {
      start: (command, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'server/main.mjs') {
          const done = new Promise(resolve => { finishService = resolve; });
          reached();
          return { done, stop: async () => finishService({ code: 0 }) };
        }
        return { done: Promise.resolve({ code: 0 }), stop: async () => {} };
      },
    });
    await serviceStarted;
    const snapshot = [...calls];
    await manager.stop();
    return snapshot;
  }
  for (const stage of STAGE_DEFINITIONS) {
    const root = temporary(t);
    fs.mkdirSync(path.join(root, 'workspace'));
    const calls = await boot(stage, root);
    const agentAt = calls.indexOf('run agent:init');
    const serverAt = calls.indexOf('server/main.mjs');
    assert.ok(serverAt >= 0, stage.id);
    if (stage.id === 's10' || stage.id === 's11') {
      assert.ok(agentAt >= 0 && agentAt < serverAt, stage.id);
      assert.ok(calls.indexOf('run data:migrate') < agentAt, stage.id);
      assert.ok(agentAt < calls.indexOf('run knowledge:init'), stage.id);
      const again = await boot(stage, root);
      assert.ok(again.includes('run agent:init') && again.indexOf('run agent:init') < again.indexOf('server/main.mjs'), stage.id);
      assert.ok(!again.includes('run knowledge:init'), stage.id);
    } else assert.equal(agentAt, -1, stage.id);
  }
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'workspace'));
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); original(...args); };
  t.after(() => { console.error = original; });
  const calls = [];
  let slept;
  const waiting = new Promise(resolve => { slept = resolve; });
  const manager = superviseStage(STAGE_DEFINITIONS.find(stage => stage.id === 's10'), root, {}, {
    start: (command, args) => {
      calls.push(args.join(' '));
      return { done: Promise.resolve({ code: args.includes('agent:init') ? 1 : 0 }), stop: async () => {} };
    },
    sleep: async () => { slept(); },
  });
  await waiting;
  assert.ok(calls.includes('run agent:init'));
  assert.equal(calls.includes('server/main.mjs'), false);
  assert.ok(logs.some(line => line.includes('[s10]') && line.includes('初始化失败')));
  await manager.stop();
});

test('健康检查使用连接文件令牌并识别缺失、退化、错端口；不监听端口', async t => {
  const root = temporary(t), stages = selectStages('s03,s08');
  for (const stage of stages) {
    const directory = path.join(root, stage.directory, '.data'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${stage.port}`, token: 'test-token-sixteen' }));
  }
  let count = 0;
  const request = async (url, options) => {
    count++;
    assert.match(url, /^http:\/\/127\.0\.0\.1:(4313|4314)\/health$/);
    assert.equal(options.headers.authorization, 'Bearer test-token-sixteen');
    return { ok: true, json: async () => ({ status: 'ready' }) };
  };
  assert.equal(await checkHealth(stages, root, request), true);
  assert.equal(count, 2);
  assert.equal(await checkHealth(stages, root, async () => ({ ok: true, json: async () => ({ status: 'degraded' }) })), false);
  fs.unlinkSync(path.join(root, stages[0].directory, '.data/connection.json'));
  assert.equal(await checkHealth(stages, root, request), false);
  fs.writeFileSync(path.join(root, stages[1].directory, '.data/connection.json'), JSON.stringify({ url: 'http://gateway:8080', token: 'test-token-sixteen' }));
  count = 0;
  assert.equal(await checkHealth(stages, root, request), false);
  assert.equal(count, 0);
});

// s12–s18 自带完整 Compose 部署，不进入共享 stages 容器或其上传包。
const blocked = ['stages/s18-replication/server/main.mjs', 'stages/s17-sharding/server/main.mjs', 'stages/s16-coordination/server/main.mjs', 'stages/s15-hub/server/main.mjs', 'stages/s14-isolation/server/main.mjs', 'stages/s13-auth/server/main.mjs', 'stages/s12-deploy/server/main.mjs', 'app/.env', 'app/.env.production', 'app/node_modules/x', 'app/.data/auth.json',
  'stages/s03-service/.env', 'stages/s03-service/.data/connection.json', 'stages/s04-events-messages/.runs/log',
  'stages/s08-data-layer/workspace/private.txt', 'stages/s11-model-gateway/node_modules/pg/index.js',
  'stages/s03-service/key.pem', 'stages/s03-service/.npmrc', 'stages/s03-service/.aws/credentials',
  'stages/s02-multi-turn/server/main.mjs', 'stages-data/s03-service/private', '.git/config'];
test('打包白名单拒绝运行数据、凭据、其他阶段，保留 package lock、示例和阶段所需代码', () => {
  for (const file of blocked) assert.equal(deployable(file), false, file);
  for (const stage of STAGE_DEFINITIONS) {
    for (const file of ['package-lock.json', '.env.example', 'server/main.mjs', 'agents/writing/role.md', 'skills/knowledge/SKILL.md']) {
      assert.equal(deployable(`stages/${stage.directory}/${file}`), true);
    }
  }
});

test('打包 head/worktree 实际产物不含被 Git 列出的敏感文件；不创建提交、不连接服务器', t => {
  const temp = temporary(t), root = path.join(temp, 'repo'), bin = path.join(temp, 'bin');
  fs.mkdirSync(bin); fs.mkdirSync(root);
  const included = ['app/deploy/stages.Dockerfile', 'app/deploy/remote.sh', 'app/.env.example',
    ...STAGE_DEFINITIONS.map(stage => `stages/${stage.directory}/package-lock.json`)];
  const files = [...included, ...blocked];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), blocked.includes(file) ? 'SECRET-CANARY' : 'public-code');
  }
  // 仅 Git 元数据被替身替代；HEAD 模式用真实 tar 走归档/解包链，不生成任何 Git 提交。
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nif(args.includes('ls-tree')||args.includes('ls-files')) process.stdout.write(JSON.parse(process.env.FIXTURE_FILES).join('\\0')+'\\0');\nelse if(args.includes('rev-parse')) console.log('fixture');\nelse if(args.includes('archive')) { const files=args.slice(args.indexOf('--')+1); const r=spawnSync('tar',['-cf','-','-C',args[1],...files],{stdio:'inherit'});process.exit(r.status); } else process.exit(1);\n`, { mode: 0o755 });
  for (const source of ['head', 'worktree']) {
    const output = path.join(temp, source);
    const result = spawnSync(process.execPath, [path.join(app, 'deploy/package-deploy.mjs'), root, output, source], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_FILES: JSON.stringify(files) },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const file of included) assert.equal(fs.readFileSync(path.join(output, file), 'utf8'), 'public-code');
    for (const file of blocked) assert.ok(!fs.existsSync(path.join(output, file)), file);
    assert.equal(fs.readFileSync(path.join(output, 'app/REVISION'), 'utf8').trim(), `fixture${source === 'worktree' ? '-worktree' : ''}`);
  }
  const remote = fs.readFileSync(path.join(app, 'deploy/remote.sh'), 'utf8');
  assert.match(remote, /node "\$APP\/deploy\/package-deploy.mjs"/);
  assert.match(remote, /"\$stage\/stages\/" "\$DEPLOY_HOST:\$APP_DIR\/\.\.\/stages\/"/);
  assert.doesNotMatch(remote, /rsync[^\n]*stages-data/);
});

function interpolate(value, environment) {
  for (let i = 0; i < 5; i++) value = value.replace(/\$\{([^{}]+)\}/g, (_, expression) => {
    const [key, fallback = ''] = expression.split(':-'); return environment[key] || fallback;
  });
  return value;
}
function volumes(section, env) {
  return [...section.matchAll(/^      - "(.+)"$/gm)].map(match => interpolate(match[1], env).split(':'));
}
test('compose：profile、共享网络、依赖、资源限制、所有持久卷和 web 只读目标路径一致', () => {
  const compose = fs.readFileSync(path.join(app, 'compose.yaml'), 'utf8');
  const stages = compose.split('\n  stages:\n')[1].split('\n  web:\n')[0];
  const web = compose.split('\n  web:\n')[1].split('\n  chroma:\n')[0];
  assert.match(stages, /profiles: \["app"\]/);
  assert.match(stages, /context: \.\.\n/);
  assert.match(stages, /dockerfile: app\/deploy\/stages.Dockerfile/);
  assert.match(stages, /network_mode: "service:agent"/);
  assert.match(stages, /mem_limit: \$\{STAGES_MEMORY_LIMIT:-1800m\}/);
  assert.match(stages, /restart: unless-stopped/);
  for (const dependency of ['postgres', 'redis', 'gateway', 'agent']) assert.match(stages, new RegExp(`${dependency}: \\{ condition: service_`));
  assert.doesNotMatch(stages, /env_file:|ports:|KIMI_API_KEY|OPENAI_API_KEY/);
  assert.match(stages, /"--health"/);
  for (const env of [{}, { CONTAINER_APP_DIR: '/srv/deployment/app' }, { CONTAINER_APP_DIR: '/srv/deployment/app', CONTAINER_STAGES_DIR: '/srv/deployment/stages' }]) {
    const stageVolumes = volumes(stages, env), webVolumes = volumes(web, env);
    for (const stage of STAGE_DEFINITIONS) {
      const root = path.resolve(env.CONTAINER_APP_DIR || '/app', '..', 'stages', stage.directory);
      for (const directory of ['.data', '.runs', 'workspace']) {
        const source = `../stages-data/${stage.directory}/${directory}`;
        const mount = stageVolumes.find(([host]) => host === source);
        assert.ok(mount, source); assert.equal(path.normalize(mount[1]), path.join(root, directory));
        assert.equal(mount.length, 2);
        if (directory === '.data') {
          const read = webVolumes.find(([host]) => host === source);
          assert.ok(read); assert.equal(path.normalize(read[1]), path.normalize(mount[1])); assert.equal(read[2], 'ro');
        }
      }
    }
  }
  const dockerfile = fs.readFileSync(path.join(app, 'deploy/stages.Dockerfile'), 'utf8');
  assert.equal(dockerfile.match(/^FROM (.+)$/m)[1], fs.readFileSync(path.join(app, 'Dockerfile'), 'utf8').match(/^FROM (.+)$/m)[1]);
  for (const stage of STAGE_DEFINITIONS) assert.ok(dockerfile.includes(`COPY stages/${stage.directory}/ ./${stage.directory}/`));
  assert.match(dockerfile, /npm ci --omit=dev/); assert.match(dockerfile, /USER node/);
  const ignore = fs.readFileSync(path.join(app, 'deploy/stages.Dockerfile.dockerignore'), 'utf8');
  for (const entry of ['**/.env', '**/node_modules', '**/.data', '**/.runs', '**/workspace', '**/*.pem']) assert.ok(ignore.includes(entry));
  assert.match(fs.readFileSync(path.join(app, 'package.json'), 'utf8'), /tests\/\*\.test\.mjs/);
});


test('容器重建后的 PID 锁：清除无进程/被其他阶段复用的旧锁，拒绝同阶段活进程', t => {
  const root = temporary(t), proc = path.join(root, 'proc');
  fs.mkdirSync(path.join(root, '.data'));
  const lock = path.join(root, '.data/server.lock');
  const write = () => fs.writeFileSync(lock, JSON.stringify({ pid: 42 }));
  write(); clearObsoleteLock(root, proc); assert.ok(!fs.existsSync(lock));
  fs.mkdirSync(path.join(proc, '42'), { recursive: true });
  fs.symlinkSync('/different-stage', path.join(proc, '42/cwd'));
  write(); clearObsoleteLock(root, proc); assert.ok(!fs.existsSync(lock));
  fs.unlinkSync(path.join(proc, '42/cwd')); fs.symlinkSync(root, path.join(proc, '42/cwd'));
  write(); assert.throws(() => clearObsoleteLock(root, proc), /活进程/); assert.ok(fs.existsSync(lock));
});

test('真实子进程收到 SIGTERM 正常退出；不启动任何网络服务', async t => {
  const root = temporary(t), ready = path.join(root, 'ready'), closed = path.join(root, 'closed');
  const code = `const fs = require('node:fs'); const timer = setInterval(() => {}, 1000); process.on('SIGTERM', () => { fs.writeFileSync(process.argv[2], 'closed'); clearInterval(timer); }); fs.writeFileSync(process.argv[1], 'ready');`;
  const task = startCommand(process.execPath, ['-e', code, ready, closed], { cwd: root, env: {}, id: 'test' });
  t.after(() => task.stop());
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready));
  await task.stop();
  assert.equal(fs.readFileSync(closed, 'utf8'), 'closed');
  assert.equal((await task.done).code, 0);
});

test('数据库创建使用阶段 pg、连接 agent 管理库；参数化查重，仅创建缺失库', async t => {
  const root = temporary(t), module = path.join(root, 'node_modules/pg');
  fs.mkdirSync(module, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(module, 'index.js'), `exports.Client = class {
    constructor(options) { this.calls = [['constructor', options]]; globalThis.stageDatabaseCalls = this.calls; }
    async connect() { this.calls.push(['connect']); }
    async query(sql, values) { this.calls.push([sql, values]); return { rowCount: globalThis.stageDatabaseExists ? 1 : 0 }; }
    async end() { this.calls.push(['end']); }
  };`);
  t.after(() => { delete globalThis.stageDatabaseCalls; delete globalThis.stageDatabaseExists; });
  const url = stageEnvironment('s08', deployment).DATABASE_URL;
  await ensureDatabase(root, url);
  let calls = globalThis.stageDatabaseCalls;
  assert.equal(new URL(calls[0][1].connectionString).pathname, '/agent');
  assert.deepEqual(calls[2], ['SELECT 1 FROM pg_database WHERE datname = $1', ['agent_s08']]);
  assert.equal(calls[3][0], 'CREATE DATABASE "agent_s08"');
  assert.deepEqual(calls.at(-1), ['end']);
  globalThis.stageDatabaseExists = true;
  await ensureDatabase(root, url);
  calls = globalThis.stageDatabaseCalls;
  assert.ok(!calls.some(([sql]) => sql.startsWith('CREATE')));
  await assert.rejects(ensureDatabase(root, url.replace('agent_s08', 'unexpected')), /非法/);
});


test('阶段真实 PROJECT_ROOT 与 connection.json 写入规则和部署挂载契约一致', async t => {
  const temporaryRoot = temporary(t);
  for (const stage of STAGE_DEFINITIONS) {
    const source = path.join(repo, 'stages', stage.directory);
    const { PROJECT_ROOT } = await import(pathToFileURL(path.join(source, 'shared/paths.mjs')));
    const { createLifecycle, publishConnection } = await import(pathToFileURL(path.join(source, 'server/modules/lifecycle/index.mjs')));
    assert.equal(path.resolve(PROJECT_ROOT), source);
    const root = path.join(temporaryRoot, stage.directory);
    fs.mkdirSync(path.join(root, '.data'), { recursive: true });
    const lifecycle = createLifecycle(), connection = { url: `http://127.0.0.1:${stage.port}`, token: 'fixture-only-token', pid: process.pid };
    publishConnection(root, connection, lifecycle);
    const file = path.join(root, '.data/connection.json');
    assert.equal(JSON.parse(fs.readFileSync(file)).url, connection.url);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    await lifecycle.close();
    assert.ok(!fs.existsSync(file));
  }
});

// 不监听端口的编排测试也验证 main 所依赖的失败传播和清理契约。
test('转发器就绪后才启动阶段；监听器故障向 main 传播并关闭全部阶段', async () => {
  const calls = [], signals = new EventEmitter();
  let ready, fail;
  const done = new Promise(resolve => { fail = resolve; });
  const running = runStageServices(selectStages('s03,s04').map(stage => ({ stage, env: {} })), '/stages', {
    signals,
    startForwarder: () => new Promise(resolve => { ready = () => resolve({ done, stop: async () => { calls.push('forwarder:stop'); } }); }),
    supervise: stage => {
      calls.push(`${stage.id}:start`);
      return { done: new Promise(() => {}), preventRestart: () => calls.push(`${stage.id}:prevent`), stop: async () => { calls.push(`${stage.id}:stop`); } };
    },
  });
  assert.deepEqual(calls, []);
  ready();
  await Promise.resolve();
  assert.deepEqual(calls, ['s03:start', 's04:start']);
  const error = new Error('listener failed');
  fail(error);
  await assert.rejects(running, actual => actual === error);
  assert.deepEqual(calls.slice(2), ['s03:prevent', 's04:prevent', 's04:stop', 's03:stop', 'forwarder:stop']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('转发器启动失败不启动阶段；SIGTERM/SIGINT 正常关闭监听和阶段', async () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'startup-error']) {
    const signals = new EventEmitter(), calls = [];
    const running = runStageServices([{ stage: STAGE_DEFINITIONS[0], env: {} }], '/stages', {
      signals,
      startForwarder: async () => {
        if (signal === 'startup-error') throw new Error('EADDRINUSE');
        return { done: new Promise(() => {}), stop: async () => { calls.push('forwarder:stop'); } };
      },
      supervise: () => {
        calls.push('start');
        return { done: new Promise(() => {}), preventRestart: () => calls.push('prevent'), stop: async () => { calls.push('stop'); } };
      },
    });
    if (signal === 'startup-error') {
      await assert.rejects(running, /EADDRINUSE/);
      assert.deepEqual(calls, []);
    } else {
      await Promise.resolve();
      signals.emit(signal);
      await running;
      assert.deepEqual(calls, ['start', 'prevent', 'stop', 'forwarder:stop']);
    }
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  }
});

test('转发器监听 error/意外 close 均报告致命结果，正常关闭不报故障', async () => {
  for (const event of ['error', 'close', 'stop']) {
    const logs = [];
    const server = new EventEmitter();
    server.listen = (port, host) => {
      assert.equal(port, 4331); assert.equal(host, '127.0.0.1');
      queueMicrotask(() => server.emit('listening'));
    };
    server.address = () => ({ address: '127.0.0.1', port: 4331 });
    server.close = callback => { server.emit('close'); callback(); };
    const forwarder = await startGatewayForwarder({ createServer: () => server, log: line => logs.push(line) });
    if (event === 'error') server.emit('error', Object.assign(new Error('private-data'), { code: 'TEST_FAILURE' }));
    if (event === 'close') server.emit('close');
    if (event === 'stop') await forwarder.stop();
    const result = await forwarder.done;
    assert.equal(result instanceof Error, event !== 'stop');
    await forwarder.stop();
    assert.equal(logs.length, event === 'stop' ? 0 : 1);
    assert.doesNotMatch(logs.join('\n'), /private-data/);
  }
});

test('4331 与 compose 共享网络及已知端口不冲突，也不发布到宿主', () => {
  assert.equal(GATEWAY_FORWARD_PORT, 4331);
  assert.equal(GATEWAY_URL, 'http://127.0.0.1:4331/v1');
  const compose = fs.readFileSync(path.join(app, 'compose.yaml'), 'utf8');
  assert.match(compose, /AGENT_PORT: "4317"/);
  assert.match(compose, /WORKBENCH_PORT: "14320"/);
  assert.match(compose, /AGENT_GATEWAY_PORT:-4330\}:8080/);
  const reserved = [...Array.from({ length: 13 }, (_, i) => 4313 + i), 14320, 4330, 5432, 6379, 8080];
  assert.ok(!reserved.includes(GATEWAY_FORWARD_PORT));
  const listeners = [4317, 14320, GATEWAY_FORWARD_PORT, ...STAGE_DEFINITIONS.map(stage => stage.port)];
  assert.equal(new Set(listeners).size, listeners.length);
  const stages = compose.split('\n  stages:\n')[1].split('\n  web:\n')[0];
  assert.match(stages, /network_mode: "service:agent"/);
  assert.doesNotMatch(stages, /^    ports:/m);
});

// 以下测试使用真实回环监听；沙箱若禁止 listen，应在沙箱外跑，不自动跳过。
async function listenTestServer(t, onConnection) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onConnection(socket);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return server;
}
async function testForwarder(t, server, options = {}) {
  const forwarder = await startGatewayForwarder({ port: 0, upstreamHost: '127.0.0.1', upstreamPort: server.address().port, ...options });
  t.after(() => forwarder.stop());
  return forwarder;
}
function testClient(t, forwarder) {
  const socket = net.createConnection({ host: '127.0.0.1', port: forwarder.address.port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  return socket;
}
const tcpOptions = { timeout: 10_000 };

test('TCP：并发连接原样双向传输二进制大数据，客户端半关闭后仍完整收到响应', tcpOptions, async t => {
  const payload = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256));
  const received = [];
  const upstream = await listenTestServer(t, socket => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => {
      const request = Buffer.concat(chunks);
      received.push(request);
      socket.end(Buffer.concat([Buffer.from('response\0'), request]));
    });
  });
  const forwarder = await testForwarder(t, upstream);
  assert.equal(forwarder.address.address, '127.0.0.1');
  await Promise.all([1, 2].map(async () => {
    const client = testClient(t, forwarder), chunks = [];
    client.on('data', chunk => chunks.push(chunk));
    const ended = once(client, 'end');
    client.end(payload);
    await ended;
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from('response\0'), payload]));
  }));
  assert.equal(received.length, 2);
  for (const request of received) assert.deepEqual(request, payload);
});

test('TCP：上游拒绝连接时记录错误并关闭客户端，监听继续可用', tcpOptions, async t => {
  const upstream = await listenTestServer(t, () => {});
  const logs = [];
  const forwarder = await testForwarder(t, upstream, { log: line => logs.push(line) });
  await new Promise(resolve => upstream.close(resolve));
  const client = testClient(t, forwarder);
  await new Promise(resolve => client.once('close', resolve));
  assert.ok(client.destroyed);
  assert.ok(logs.some(line => /upstream connection error \(ECONNREFUSED\)/.test(line)));
  const second = testClient(t, forwarder);
  await new Promise(resolve => second.once('close', resolve));
  assert.equal(logs.length, 2);
});

test('TCP：上游复位会记录错误并关闭客户端', tcpOptions, async t => {
  const logs = [];
  const upstream = await listenTestServer(t, socket => socket.once('data', () => socket.resetAndDestroy()));
  const forwarder = await testForwarder(t, upstream, { log: line => logs.push(line) });
  const client = testClient(t, forwarder);
  const closed = new Promise(resolve => client.once('close', resolve));
  client.write('request');
  await closed;
  assert.ok(logs.some(line => /upstream connection error/.test(line)));
});

test('TCP：客户端复位关闭上游；停止转发器关闭活跃连接并释放监听端口', tcpOptions, async t => {
  let connected;
  let accepted = new Promise(resolve => { connected = resolve; });
  const upstream = await listenTestServer(t, socket => connected(socket));
  const logs = [];
  const forwarder = await testForwarder(t, upstream, { log: line => logs.push(line) });
  const client = testClient(t, forwarder);
  const remote = await accepted;
  remote.resume();
  remote.on('end', () => remote.end());
  const remoteClosed = once(remote, 'close');
  client.resetAndDestroy();
  await remoteClosed;
  assert.ok(logs.some(line => /client connection error/.test(line)));
  accepted = new Promise(resolve => { connected = resolve; });
  const second = testClient(t, forwarder);
  const secondRemote = await accepted;
  secondRemote.resume();
  secondRemote.on('end', () => secondRemote.end());
  const closed = Promise.all([once(second, 'close'), once(secondRemote, 'close')]);
  await forwarder.stop();
  await closed;
  assert.equal(await forwarder.done, null);
  const probe = net.createServer();
  t.after(() => new Promise(resolve => probe.close(resolve)));
  const listening = once(probe, 'listening');
  probe.listen(forwarder.address.port, '127.0.0.1');
  await listening;
});

test('TCP：监听端口已被占用时启动失败且记录错误', tcpOptions, async t => {
  const occupied = await listenTestServer(t, () => {}), logs = [];
  await assert.rejects(startGatewayForwarder({ port: occupied.address().port, log: line => logs.push(line) }), { code: 'EADDRINUSE' });
  assert.ok(logs.some(line => line.includes('EADDRINUSE')));
});
