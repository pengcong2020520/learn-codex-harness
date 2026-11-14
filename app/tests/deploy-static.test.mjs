import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const compose = read('compose.yaml');
const service = name => compose.match(new RegExp(`^  ${name}:(?: &node)?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:|$(?![\\s\\S]))`, 'm'))?.[1];

for (const script of ['backup', 'restore']) test(`static: ${script} 在获取下载锁前检查非 root 用户的备份目录写权限`, () => {
  const source = read(`deploy/${script}.sh`);
  const guard = source.match(/if \[ "\$\(id -u\)" != 0 \] && \[ ! -w backups \]; then\n([\s\S]*?)\nfi/);
  assert.ok(guard, '非 root 且 backups 不可写时必须提前退出');
  assert.ok(guard.index + guard[0].length < source.indexOf('exec 9>backups/.download.lock'), '权限检查必须在获取锁之前');
  assert.ok(guard[1].includes(`需要 root 权限（定时任务也以 root 运行）：请运行 sudo bash deploy/${script}.sh`));
  assert.match(guard[1], />&2/);
  assert.match(guard[1], /\bexit 1\b/);
});

test('static: Compose 无必填插值，长期业务服务经 prepare 门禁、节点经 migrate 门禁', () => {
  assert.doesNotMatch(compose, /:\?/);
  for (const name of ['postgres', 'redis', 'etcd', 'gateway', 'etcd-init', 'migrate']) {
    assert.match(service(name), /prepare: \{ condition: service_completed_successfully(?:, restart: true)? \}/, name);
  }
  assert.match(service('node-a'), /migrate: \{ condition: service_completed_successfully \}/);
  for (const name of ['node-b', 'node-c']) assert.match(service(name), /<<: \*node/);
  assert.match(service('caddy'), /node-a: \{ condition: service_healthy \}/);
  // 两个显式 remote-access profile 的中继按任务约定保持独立。
  for (const name of ['remote-access', 'remote-node-link']) assert.doesNotMatch(service(name), /depends_on:/);
  for (const name of ['prepare', 'migrate', 'etcd-init']) {
    assert.match(service(name), /image: codex-agent:current/);
    assert.match(service(name), /build: \*agent-build/);
    assert.match(service(name), /restart: "no"/);
  }
  for (const name of ['postgres', 'redis']) assert.match(service('migrate'), new RegExp(`${name}: \\{ condition: service_healthy \\}`));
  assert.match(service('migrate'), /etcd-init: \{ condition: service_completed_successfully \}/);
  assert.match(service('migrate'), /cluster-migrate.mjs && npm run -s agent:init && node scripts\/compose-init.mjs copy-identities/);
});

test('static: 网关目录复制到 tmpfs，保留官方入口、共享组与健康检查', () => {
  const gateway = service('gateway');
  assert.match(gateway, /volumes: \["\.\/\.data\/gateway:\/gateway-config:ro"\]/);
  assert.doesNotMatch(gateway, /gateway\/[^\s]+\.json:/);
  assert.match(gateway, /tmpfs: \["\/app\/data:uid=1000,gid=0,mode=0770"\]/);
  assert.match(gateway, /group_add: \["1000"\]/);
  assert.match(gateway, /cp \/gateway-config\/config.json \/gateway-config\/model-parameters.json \/app\/data\/; exec \/app\/docker-entrypoint.sh \/app\/main/);
  assert.match(gateway, /prepare: \{ condition: service_completed_successfully, restart: true \}/);
  assert.match(gateway, /test: \["CMD", "wget", "-q", "-O", "\/dev\/null", "http:\/\/127.0.0.1:8080\/health"\]/);
});

test('Dockerfile：缺失或相对部署路径在安装依赖前中文报错', () => {
  const dockerfile = read('Dockerfile'), guard = dockerfile.match(/^RUN case .*$/m)?.[0];
  assert.ok(guard);
  assert.ok(dockerfile.indexOf(guard) < dockerfile.indexOf('apt-get update'));
  assert.ok(dockerfile.indexOf(guard) < dockerfile.indexOf('WORKDIR'));
  for (const value of [undefined, '', 'relative', '/srv/agent', '/srv/带空格 agent']) {
    const result = spawnSync('/bin/sh', ['-c', guard.slice(4)], { env: value === undefined ? {} : { CONTAINER_APP_DIR: value }, encoding: 'utf8' });
    assert.equal(result.status, value?.startsWith('/') ? 0 : 1);
    if (result.status) assert.equal(result.stderr.trim(), '缺少 CONTAINER_APP_DIR：请先运行配置向导（npm run setup）生成 .env');
  }
});

test('static: E2E 直接 Compose 再启动并以同一账号登录，之后保留三节点扩容', () => {
  const source = read('scripts/e2e-compose.sh');
  assert.match(source, /docker compose stop\ndocker compose up -d --wait\nprintf '%s\\n' "\$password" \| node scripts\/e2e-check.mjs --login-only\nSETUP_ADMIN_PASSWORD="\$password" npm run cluster:enable -- --yes/);
});

test('static: 默认服务含初始化链与可选集群、三节点独立卷、仅 Caddy 回环入口、固定内存与健康语义', () => {
  assert.deepEqual([...compose.split('services:\n')[1].split('\nnetworks:')[0].split('\nvolumes:')[0].matchAll(/^  ([a-z-]+):(?: &node)?$/gm)].map(m => m[1]), ['setup', 'check', 'prepare', 'migrate', 'postgres', 'redis', 'gateway', 'etcd-init', 'node-a', 'node-b', 'node-c', 'etcd', 'caddy', 'edge', 'remote-access', 'remote-node-link']);
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
  assert.ok(service('etcd').includes('test: ["CMD", "etcdctl", "--endpoints=http://127.0.0.1:2379", "--user", "health:${ETCD_HEALTH_PASSWORD:-}", "endpoint", "health"]'));
  assert.match(service('etcd-init'), /ETCD_HEALTH_PASSWORD: \$\{ETCD_HEALTH_PASSWORD:-\}/);
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

test('static: HTTPS 显式启用，只有 edge 公开端口，证书持久化且保留 SSE 与 Host', () => {
  const edge = service('edge');
  assert.match(edge, /profiles: \[https\]/);
  assert.equal(edge.match(/image: (.*)/)[1], service('caddy').match(/image: (.*)/)[1]);
  assert.match(edge, /<<: \*runtime/); assert.match(edge, /mem_limit: 64m/);
  assert.match(edge, /caddy: \{ condition: service_healthy \}/);
  assert.match(edge, /edge-data:\/data/); assert.match(edge, /edge-config:\/config/);
  assert.deepEqual([...edge.matchAll(/"(0\.0\.0\.0:[^"\n]+)"/g)].map(m => m[1]), ['0.0.0.0:80:80', '0.0.0.0:443:443']);
  for (const [, name] of compose.matchAll(/^  ([a-z-]+):(?: &node)?$/gm)) {
    const block = service(name).match(/    ports:([^]*?)(?=\n    \w|$)/)?.[1];
    if (block && name !== 'edge') {
      const ports = [...block.matchAll(/"([^"\n]+)"/g)].map(m => m[1]);
      assert.ok(ports.length > 0); assert.ok(ports.every(port => port.startsWith('127.0.0.1:')), name);
    }
  }
  const caddy = read('deploy/Caddyfile.edge');
  assert.match(caddy, /\{\$AGENT_DOMAIN\}/); assert.match(caddy, /reverse_proxy caddy:80/);
  assert.match(caddy, /header_up Host \{http.request.host\}/); assert.match(caddy, /flush_interval -1/);
  assert.doesNotMatch(caddy, /^\s*log(?:\s|$)/m);
});
test('static: check 使用镜像代码和依赖、独立只读项目与 DAC_READ_SEARCH，无网络', () => {
  const check = service('check');
  for (const text of ['profiles: [tools]', 'image: codex-agent:current', 'network_mode: none', 'read_only: true', 'cap_drop: [ALL]', 'cap_add: [DAC_READ_SEARCH]', 'source: .', 'target: /project', 'HOST_APP_DIR: ${PWD:-/nonexistent}', 'working_dir: ${CONTAINER_APP_DIR:-/nonexistent}', 'command: ["node", "scripts/production-check.mjs", "--root", "/project"]', 'bind: { create_host_path: false }']) assert.ok(check.includes(text), text);
  assert.equal((check.match(/type: bind/g) || []).length, 1);
  assert.match(check, /target: \/project\n\s+read_only: true/);
  assert.doesNotMatch(check, /read_only: false|docker.sock|depends_on:|type: volume|node_modules|target: \$\{CONTAINER_APP_DIR/);
});
test('static: 定时备份每天本地 04:00，补跑漏执行任务，安装器启用 timer', () => {
  const timer = read('deploy/systemd/codex-agent-backup.timer'), unit = read('deploy/systemd/codex-agent-backup.service');
  assert.match(timer, /^OnCalendar=\*-\*-\* 04:00:00$/m); assert.match(timer, /^Persistent=true$/m);
  assert.match(unit, /^WorkingDirectory=@APP_DIR@$/m); assert.match(unit, /^ExecStart=\/bin\/bash deploy\/backup.sh$/m);
  const installer = read('deploy/enable-backup-timer.sh');
  assert.match(installer, /systemctl daemon-reload/); assert.match(installer, /systemctl enable --now codex-agent-backup.timer/);
});

test('edge 入口只接受空 TLS 或 internal，环境不能注入任意 Caddy 指令', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-entrypoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'caddy'), '#!/bin/sh\nprintf "%s" "$AGENT_TLS_DIRECTIVE"\n', { mode: 0o755 });
  for (const [domain, tls, status, directive] of [['agent.example.com', '', 0, ''], ['agent.localhost', 'internal', 0, 'tls internal'], ['', '', 1, ''], ['agent.example.com', 'internal\nlog', 1, '']]) {
    const result = spawnSync('sh', ['deploy/edge-entrypoint.sh'], { cwd: new URL('../', import.meta.url), env: { PATH: `${root}:${process.env.PATH}`, AGENT_DOMAIN: domain, AGENT_TLS: tls }, encoding: 'utf8' });
    assert.equal(result.status, status); assert.equal(result.stdout, directive);
    if (status) assert.match(result.stderr, /AGENT_DOMAIN|AGENT_TLS/);
  }
});
