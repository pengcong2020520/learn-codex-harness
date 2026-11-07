import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const compose = read('compose.yaml');
const service = name => compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:|$(?![\\s\\S]))`, 'm'))?.[1];

test('static: 四个服务、仅回环发布、健康依赖、固定资源与日志轮转', () => {
  assert.deepEqual([...compose.split('services:\n')[1].split('\nvolumes:')[0].matchAll(/^  ([a-z]+):$/gm)].map(m => m[1]), ['postgres', 'redis', 'gateway', 'agent']);
  for (const [name, limit] of Object.entries({ postgres: '256m', redis: '128m', gateway: '256m', agent: '768m' })) {
    const text = service(name);
    assert.ok(text, name); assert.match(text, /<<: \*runtime/); assert.ok(text.includes(`:-${limit}}`)); assert.match(text, /healthcheck:/);
  }
  assert.match(compose, /restart: unless-stopped/); assert.match(compose, /stop_grace_period: 30s/);
  assert.match(compose, /driver: json-file/); assert.match(compose, /max-size: "10m"/); assert.match(compose, /max-file: "3"/);
  const ports = [...compose.matchAll(/ports: \["([^"]+)"\]/g)].map(m => m[1]);
  assert.deepEqual(ports, ['127.0.0.1:${AGENT_PORT:-4327}:4327']);
  assert.match(service('gateway'), /postgres: \{ condition: service_healthy \}/);
  for (const name of ['postgres', 'redis', 'gateway']) assert.ok(service('agent').includes(`${name}: { condition: service_healthy }`));
  assert.match(service('agent'), /deploy\/ready.mjs/); assert.match(read('deploy/ready.mjs'), /\/ready/);
  for (const name of ['.data', '.runs', 'workspace', 'backups']) assert.ok(service('agent').includes(`./${name}:\${CONTAINER_APP_DIR}/${name}`));
});
test('static: agent 无服务商密钥、gateway 无数据库凭据，Docker 不复制运行数据', () => {
  assert.doesNotMatch(compose, /env_file:/);
  assert.doesNotMatch(service('agent'), /(?:KIMI|OPENAI|ARK|ANTHROPIC|GEMINI|DEEPSEEK|XAI|ZHIPU|HUGGINGFACE)_API_KEY/);
  assert.doesNotMatch(service('gateway'), /DATABASE_URL|AGENT_DB_PASSWORD|REDIS_URL/);
  assert.match(service('agent'), /AGENT_GATEWAY_KEY:/);
  const docker = read('Dockerfile');
  assert.match(docker, /FROM node:24\.19\.0-slim@sha256:[a-f0-9]{64}/);
  assert.match(docker, /USER node/); assert.match(docker, /lsof bubblewrap/);
  assert.doesNotMatch(docker, /postgresql-client/); assert.doesNotMatch(docker, /pg_dump --version/);
  assert.match(docker, /npm ci --omit=dev/); assert.match(docker, /ARG NPM_REGISTRY/); assert.match(docker, /ARG APT_MIRROR/);
  for (const name of ['.env', '.data', '.runs', 'workspace', 'node_modules', 'backups']) assert.ok(read('.dockerignore').split('\n').includes(name));
  const pkg = JSON.parse(read('package.json'));
  // Freeze the s11 baseline locally: the deployed image contains only this stage.
  const before = {
    dependencies: {
      '@modelcontextprotocol/sdk': '1.30.0', '@openai/codex': '0.154.0', ajv: '8.20.0',
      htmlparser2: '12.0.0', pg: '8.23.1', redis: '6.3.0',
    },
    optionalDependencies: { chromadb: '3.5.0' },
  };
  assert.deepEqual(pkg.dependencies, before.dependencies); assert.deepEqual(pkg.optionalDependencies, before.optionalDependencies);
});
test('static: 版本回滚、下载限速与服务器 flock；不走 HTTP', () => {
  const remote = read('deploy/remote.sh'), download = read('deploy/download-rsync.sh');
  assert.match(remote, /--bwlimit=200/); assert.match(remote, /--rsync-path=/); assert.match(remote, /-e 'ssh -o BatchMode=yes'/);
  assert.match(download, /flock -n 9/); assert.match(download, /已有下载/); assert.match(download, /rsync "\$@"/);
  assert.match(remote, /codex-harness-s13:previous/); assert.match(remote, /\.previous\/REVISION/);
  assert.match(remote, /rollback\)/); assert.match(remote, /incoming\/REVISION/);
  assert.doesNotMatch(read('server/modules/http/index.mjs'), /GET \/backups/);
});
test('docs: 教学标题顺序、离线实验与源码摘录', () => {
  const chapter = read('README.md');
  assert.match(chapter, /^# s13: /); assert.match(chapter, /^> \*\*对应六个问题\*\*：/m);
  let previous = -1;
  for (const heading of ['要回答的问题', '核心概念', '分工：Codex 做什么，我们做什么', '跑起来看看', '关键代码', '小结', '下一章']) {
    const index = chapter.indexOf(`## ${heading}\n`); assert.ok(index > previous, heading); previous = index;
  }
  for (const heading of ['设计原理', '架构改进', '技术实现流程', '核心代码', '验证', '限制说明', '机制实验']) assert.ok(read('docs/design.md').includes(`## ${heading}\n`));
  const sources = ['server/modules/accounts/password.mjs', 'server/modules/accounts/index.mjs', 'server/modules/events/index.mjs'].map(read).join('\n');
  for (const block of chapter.matchAll(/```javascript\n([\s\S]*?)```/g)) for (const line of block[1].split('\n').filter(Boolean)) assert.ok(sources.includes(line), line);
  assert.ok(JSON.parse(read('lessons/catalog.json')).filter(x => x.mode === 'offline').length >= 3);
});
test('configuration: 部署模型目录使用无密钥清单，agent 启动不需要服务商密钥', async t => {
  const { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } = fs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadServerConfig } = await import('../server/modules/config/index.mjs');
  const root = mkdtempSync(join(tmpdir(), 's13-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['config', 'agents']) cpSync(new URL(`../${dir}`, import.meta.url), join(root, dir), { recursive: true });
  mkdirSync(join(root, '.data/gateway'), { recursive: true });
  writeFileSync(join(root, '.data/gateway/enabled-providers.json'), '["kimi"]');
  const config = loadServerConfig(root, { AGENT_DEPLOYED: 'true', AGENT_GATEWAY_KEY: 'sk-bf-test-only', CODEX_MODEL_CATALOG_ENABLED: 'true' });
  assert.equal(config.port, 4327); assert.ok(config.launch.catalog.models.length > 0);
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
  assert.match(remote, /rsync -az --no-owner --no-group/);
});
