import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const compose = read('compose.yaml');
const service = name => compose.match(new RegExp(`^  ${name}:(?: &node)?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:|$(?![\\s\\S]))`, 'm'))?.[1];

test('static: 默认七服务加可选集群、三节点独立卷、仅 Caddy 回环入口、固定内存与健康语义', () => {
  assert.deepEqual([...compose.split('services:\n')[1].split('\nnetworks:')[0].split('\nvolumes:')[0].matchAll(/^  ([a-z-]+):(?: &node)?$/gm)].map(m => m[1]), ['postgres', 'redis', 'gateway', 'etcd-init', 'node-a', 'node-b', 'node-c', 'etcd', 'caddy', 'remote-access', 'remote-node-link']);
  assert.match(compose, /mem_limit: 128m/); assert.match(compose, /mem_limit: 64m/);
  assert.match(compose, /AGENT_MEMORY_LIMIT:-768m/);
  assert.deepEqual([...compose.matchAll(/ports: \["([^"]+)"\]/g)].map(m => m[1]), ['127.0.0.1:${AGENT_PORT:-4317}:80']);
  for (const port of ['4340','4341','4342']) assert.ok(compose.includes(port));
  for (const node of ['a','b','c']) {
    for (const name of ['.data','.runs','workspace']) assert.ok(compose.includes(`./nodes/node-${node}/${name}:\${CONTAINER_APP_DIR}/${name}`));
    assert.ok(compose.includes(`./backups/node-${node}:\${CONTAINER_APP_DIR}/backups`));
  }
  assert.match(compose, /node-b:[\s\S]*<<: \*node/); assert.match(compose, /node-c:[\s\S]*<<: \*node/);
  assert.match(compose, /独立宿主目录/); assert.match(compose, /"--alive"/);
  assert.match(read('deploy/Caddyfile'), /health_uri \/ready/);
  assert.match(read('deploy/Caddyfile'), /\{\$AGENT_UPSTREAMS:node-a:4340\}/);
  assert.match(read('deploy/caddy-upstreams.sh'), /node-a:4340.*node-b:4341.*node-c:4342/);
  assert.match(compose, /quay.io\/coreos\/etcd:v3.7.3@/); assert.match(compose, /caddy:2.10.2-alpine@/);
  assert.match(service('remote-access'), /profiles: \[remote-access\]/);
  assert.match(service('remote-node-link'), /profiles: \[remote-access\]/);
  for (const port of ['12379','15432','16379','18080']) assert.ok(service('remote-access').includes('127.0.0.1:'+port));
  assert.match(compose, /restart: unless-stopped/); assert.match(compose, /max-size: "10m"/);
});
test('static: agent 无服务商密钥、gateway 无数据库凭据，Docker 不复制运行数据', () => {
  assert.doesNotMatch(compose, /env_file:/);
  assert.doesNotMatch(service('node-a'), /(?:KIMI|OPENAI|ARK|ANTHROPIC|GEMINI|DEEPSEEK|XAI|ZHIPU|HUGGINGFACE)_API_KEY/);
  assert.doesNotMatch(service('gateway'), /DATABASE_URL|AGENT_DB_PASSWORD|REDIS_URL/);
  assert.match(service('node-a'), /AGENT_GATEWAY_KEY:/);
  const docker = read('Dockerfile');
  assert.match(docker, /FROM node:24\.19\.0-slim@sha256:[a-f0-9]{64}/);
  assert.match(docker, /USER node/); assert.match(docker, /lsof bubblewrap/);
  assert.doesNotMatch(docker, /postgresql-client/); assert.doesNotMatch(docker, /pg_dump --version/);
  assert.match(docker, /npm ci --omit=dev/); assert.match(docker, /ARG NPM_REGISTRY/); assert.match(docker, /ARG APT_MIRROR/);
  for (const name of ['.env', '.data', '.runs', 'workspace', 'node_modules', 'backups']) assert.ok(read('.dockerignore').split('\n').includes(name));
  const pkg = JSON.parse(read('package.json'));
  // Freeze the application dependency baseline: no additional runtime libraries.
  const before = {
    dependencies: {
      '@modelcontextprotocol/sdk': '1.30.0', '@openai/codex': '0.154.0', ajv: '8.20.0',
      htmlparser2: '12.0.0', pg: '8.23.1', redis: '6.3.0', etcd3: '1.1.2',
    },
    optionalDependencies: { chromadb: '3.5.0' },
  };
  assert.deepEqual(pkg.dependencies, before.dependencies); assert.deepEqual(pkg.optionalDependencies, before.optionalDependencies);
});
test('static: 版本回滚、下载限速与服务器 flock；不走 HTTP', () => {
  const remote = read('deploy/remote.sh'), download = read('deploy/download-rsync.sh');
  assert.match(remote, /--bwlimit=200/); assert.match(remote, /--rsync-path=/); assert.match(remote, /-e 'ssh -o BatchMode=yes'/);
  assert.match(download, /flock -n 9/); assert.match(download, /已有下载/); assert.match(download, /rsync "\$@"/);
  assert.match(remote, /codex-agent:previous/); assert.match(remote, /\.previous\/REVISION/);
  assert.match(remote, /rollback\)/); assert.match(remote, /incoming\/REVISION/);
  assert.doesNotMatch(read('server/modules/http/index.mjs'), /GET \/backups/);
});
test('docs: app quickstart links to course and snapshots', () => {
  const readme = read('README.md');
  for (const text of ['默认单节点', 'AGENT_CLUSTER_NODES=node-a,node-b,node-c', 'COMPOSE_PROFILES=cluster', '../course/', '../stages/']) assert.ok(readme.includes(text), text);
});
test('configuration: 部署模型目录使用无密钥清单，agent 启动不需要服务商密钥', async t => {
  const { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } = fs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadServerConfig } = await import('../server/modules/config/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 'app-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['config', 'agents']) cpSync(new URL(`../${dir}`, import.meta.url), join(root, dir), { recursive: true });
  mkdirSync(join(root, '.data/gateway'), { recursive: true });
  writeFileSync(join(root, '.data/gateway/enabled-providers.json'), '["kimi"]');
  const config = loadServerConfig(root, { AGENT_DEPLOYED: 'true', AGENT_GATEWAY_KEY: 'sk-bf-test-only', CODEX_MODEL_CATALOG_ENABLED: 'true' });
  assert.equal(config.port, 4340); assert.ok(config.launch.catalog.models.length > 0);
  assert.equal(config.launch.env.KIMI_API_KEY, undefined); assert.equal(config.launch.env.OPENAI_API_KEY, undefined);
  assert.equal(config.launch.router.resolve().id, 'kimi/kimi-k2.7-code');
});

test('remote heredoc commands cannot swallow the rest of the script from stdin', () => {
  const remote = read('deploy/remote.sh');
  const bodies = [...remote.matchAll(/<<'REMOTE'\n([\s\S]*?)\nREMOTE/g)].map(match => match[1]);
  assert.equal(bodies.length, 2);
  for (const line of bodies.join('\n').split('\n')) {
    if (/^(docker compose|bash deploy\/)/.test(line)) assert.match(line, /<\/dev\/null$/, line);
  }
  assert.doesNotMatch(bodies.join('\n'), /ssh -t|npm run (?:auth:init|user:)/);
  assert.match(remote, /rsync -az --no-owner --no-group/);
});

test('static: 首次部署等待基础服务、迁移并只读检查账号，未初始化成功返回且不启动 agent', () => {
  const setup = read('deploy/server-setup.sh');
  const steps = ['up -d etcd\n', 'run --rm --no-deps -T etcd-init', 'up -d --wait etcd postgres redis gateway', 'node scripts/cluster-migrate.mjs', 'npm run -s agent:init', 'node scripts/accounts.mjs status', 'uninitialized)', 'up -d --wait --force-recreate "${cluster_nodes[@]}" caddy', 'bash deploy/enable-service.sh', 'bash deploy/cluster-ready.sh'];
  let previous = -1;
  for (const step of steps) {
    const index = setup.indexOf(step);
    assert.ok(index > previous, step); previous = index;
  }
  const branch = setup.match(/ uninitialized\)([\s\S]*?);;/)[1];
  assert.match(branch, /账号尚未初始化.*remote.sh auth-init/);
  assert.match(branch, /exit 0/);
  assert.doesNotMatch(branch, /docker compose up|systemctl|enable-service/);
  assert.doesNotMatch(read('deploy/configure.sh'), /docker compose up/);
  assert.match(read('deploy/remote.sh'), /bash deploy\/server-setup.sh <\/dev\/null\nrm .deploy-pending/);
  const accounts = read('scripts/accounts.mjs');
  assert.match(accounts, /create: command !== 'status'/);
  assert.match(accounts, /command === 'status'[\s\S]*?output.log\(await accountStatus\(store\)\)/);
  assert.match(accounts, /return 0;/);
});

test('static: 远程账号命令独立使用 SSH TTY、白名单名称并仅接受重复初始化退出码', () => {
  const remote = read('deploy/remote.sh');
  assert.match(remote, / auth-init\)/);
  assert.match(remote, / user\)/);
  assert.ok(remote.includes('^[a-z0-9_.-]{1,64}$'));
  assert.match(remote, /ssh -t.*bash deploy\/env-run.sh node-a node scripts\/maintenance.mjs accounts init/);
  assert.match(remote, /ssh -t.*bash deploy\/env-run.sh node-a node scripts\/maintenance.mjs accounts/);
  assert.match(remote, /code.*-eq 3/);
  assert.ok(remote.includes('source deploy/topology.sh && docker compose up -d --wait'));
  assert.match(remote, /cluster_nodes.*bash deploy\/cluster-ready.sh/);
  assert.doesNotMatch(remote, /bash deploy\/env-run.sh[^\n]*-T[^\n]*accounts/);
});

test('static: every node mounts the shared gateway directory so the one-shot generator can write', () => {
  for (const node of ['node-a', 'node-b', 'node-c']) {
    assert.ok(service(node).includes('"./.data/gateway:${CONTAINER_APP_DIR}/.data/gateway"'));
    assert.doesNotMatch(service(node), /gateway\/enabled-providers\.json:/);
  }
});

test('static: etcd health uses a dedicated user without shell; both deploy paths initialize before waiting', () => {
  assert.ok(service('etcd').includes('test: ["CMD", "etcdctl", "--endpoints=http://127.0.0.1:2379", "--user", "health:${ETCD_HEALTH_PASSWORD:?Set ETCD_HEALTH_PASSWORD}", "endpoint", "health"]'));
  assert.match(service('etcd-init'), /ETCD_HEALTH_PASSWORD: \$\{ETCD_HEALTH_PASSWORD:\?Set ETCD_HEALTH_PASSWORD\}/);
  assert.match(service('etcd-init'), /etcd: \{ condition: service_started \}/);
  assert.match(service('node-a'), /etcd: \{ condition: service_healthy \}/);
  for (const name of ['node-b', 'node-c']) assert.match(service(name), /<<: \*node/);
  assert.match(read('.env.example'), /^ETCD_HEALTH_PASSWORD=$/m);
  assert.match(read('scripts/deploy-env.mjs'), /values.ETCD_HEALTH_PASSWORD = randomBytes\(24\).toString\('hex'\)/);
  for (const file of ['deploy/server-setup.sh', 'deploy/bootstrap.sh']) {
    const source = read(file);
    const start = source.indexOf('docker compose up -d etcd\n');
    const init = source.indexOf('docker compose run --rm --no-deps -T etcd-init');
    const wait = source.indexOf('docker compose up -d --wait');
    assert.ok(start >= 0 && start < init && init < wait, file);
    assert.ok(source.indexOf('docker compose stop "${cluster_nodes[@]}"') < init, file);
  }
});

test('static: nodes never tighten the shared gateway config directory (gateway container reads it as another uid)', () => {
  const source = fs.readFileSync(new URL('../server/modules/runtimes/directories.mjs', import.meta.url), 'utf8');
  assert.match(source, /'gateway'\]\.includes\(entry\)\) secureTree/);
});
