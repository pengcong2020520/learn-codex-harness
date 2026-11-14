import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDefinition } from '../server/modules/agents/schema.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { CONTRACTS, digest } from '../server/modules/agents/contracts.mjs';
import { newAgent, PLACEHOLDER_DESCRIPTION, PLACEHOLDER_STARTERS } from '../scripts/agent-new.mjs';
import { checkAgent } from '../scripts/agent-check.mjs';
import { checkProductionFiles } from '../scripts/production-check.mjs';
import { checkProduction } from '../server/modules/deployment/production.mjs';
import { productionFileInputs } from '../server/modules/deployment/production-inputs.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { accountFixture, httpFixture, request } from './accounts-fixture.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['agents', 'config']) fs.cpSync(new URL(`../${dir}`, import.meta.url), path.join(root, dir), { recursive: true });
  const file = path.join(root, 'agents/writing/agent.json');
  const definition = JSON.parse(fs.readFileSync(file));
  const write = () => fs.writeFileSync(file, JSON.stringify(definition));
  return { root, file, definition, write };
}

for (const field of ['description', 'starters']) {
  test(`Agent schema：${field} 的类型、长度与数量边界`, t => {
    const { definition } = fixture(t);
    const valid = field === 'description' ? ['简', '😀'.repeat(200)] : [[], ['问'], Array.from({ length: 6 }, () => '😀'.repeat(100))];
    const invalid = field === 'description' ? ['', '字'.repeat(201), 1, null, []] : ['', null, [1], [''], ['字'.repeat(101)], Array(7).fill('问')];
    for (const value of valid) { definition.agent[field] = value; assert.doesNotThrow(() => validateDefinition(structuredClone(definition))); }
    for (const value of invalid) { definition.agent[field] = value; assert.throws(() => validateDefinition(structuredClone(definition)), /Agent 定义无效/); }
    delete definition.agent[field];
    assert.doesNotThrow(() => validateDefinition(definition));
  });
}

test('旧配置正常加载；新增展示字段沿用 name 的描述符规则且不提升 CONTRACTS', t => {
  const f = fixture(t);
  delete f.definition.agent.description; delete f.definition.agent.starters; f.write();
  const old = new AgentDefinition(f.root, f.file); old.activate('fixture-tools');
  assert.equal(old.definition.agent.description, undefined);
  assert.equal(old.descriptor.contracts, CONTRACTS);
  assert.equal(CONTRACTS.agent, 2);
  f.definition.agent.description = '帮助写作者整理观点'; f.definition.agent.starters = ['请整理我的观点']; f.write();
  const current = new AgentDefinition(f.root, f.file); current.activate('fixture-tools');
  const { version, instructions, ...effective } = validateDefinition(structuredClone(f.definition)).agent;
  assert.equal(current.descriptor.definitionHash, digest(effective));
  assert.notEqual(old.descriptor.hash, current.descriptor.hash);
});

test('agent:new 的简介与两条示例占位建议、缺简介建议及超长错误', t => {
  const f = fixture(t);
  const definition = newAgent('sample', { root: f.root, log() {} });
  assert.equal(definition.agent.description, PLACEHOLDER_DESCRIPTION);
  assert.deepEqual(definition.agent.starters, PLACEHOLDER_STARTERS);
  const file = path.join(f.root, 'agents/sample/agent.json');
  assert.match(fs.readFileSync(path.join(f.root, 'agents/sample/workflows/README.md'), 'utf8'), /description.*starters.*占位/);
  let rows = checkAgent(file, f);
  for (const field of ['description', 'starters']) assert.ok(rows.some(row => row.title.endsWith(`agent.${field}`) && row.level === 'warning'));
  assert.equal(rows.some(row => row.level === 'error'), false);
  delete definition.agent.description; fs.writeFileSync(file, JSON.stringify(definition));
  rows = checkAgent(file, f);
  assert.ok(rows.some(row => row.level === 'warning' && row.fix === '补一句话说明，网页首页会显示'));
  definition.agent.description = '字'.repeat(201); fs.writeFileSync(file, JSON.stringify(definition));
  assert.ok(checkAgent(file, f).some(row => row.level === 'error' && row.title.includes('/agent/description')));
});

function environment(root) {
  return { CODEX_MODEL: 'kimi/kimi-k2.7-code', AGENT_GATEWAY_KEY: 'sk-bf-fixture-gateway-secret', // privacy-check: allow — 仅测试用假值。
    KIMI_API_KEY: 'fixture-kimi-secret', DEEPSEEK_API_KEY: 'fixture-deepseek-secret',
    AGENT_PREVIEW_SECRET: 'fixture-preview-secret', DATABASE_URL: 'postgresql://fixture:fixture-db-secret@localhost/fixture',
    REDIS_URL: 'redis://:fixture-redis-secret@localhost/0', AGENT_NODE_KEY: 'fixture-node-secret',
    AGENT_DOMAIN: 'service.example.com', AGENT_ALLOWED_ORIGINS: 'https://service.example.com', COMPOSE_PROFILES: 'cluster,https',
    AGENT_CLUSTER_NODES: 'node-a,node-b', AGENT_BUDGET_DAILY_TOKENS: '987654', AGENT_DEFINITION: 'agents/writing/agent.json', CONTAINER_APP_DIR: root };
}
async function service(t, options = {}) {
  const f = fixture(t), env = environment(f.root), config = loadServerConfig(f.root, { ...env, ...options.env });
  config.agent = new AgentDefinition(f.root, f.file);
  const { accounts, store } = await accountFixture();
  const http = httpFixture(accounts, { config }); t.after(() => http.close());
  const login = username => accounts.login({ username, password: 'fixture-password' }, 'fixture');
  return { ...f, env, config, http, store, alice: (await login('alice')).token, bob: (await login('bob')).token };
}

test('workbench 返回简介、示例、路由模型能力及可信 viewer，旧配置省略可选字段', async t => {
  const f = await service(t);
  for (const [token, username, admin] of [[f.alice, 'alice', true], [f.bob, 'bob', false]]) {
    const response = await request(f.http, '/workbench?admin=true&username=alice', { token, headers: { 'x-role': 'admin' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.viewer, { username, admin });
    assert.equal(response.body.agent.description, f.definition.agent.description);
    assert.deepEqual(response.body.agent.starters, f.definition.agent.starters);
    const catalog = f.config.launch.router.catalog(), id = catalog.defaults.chat;
    assert.deepEqual(response.body.defaultModel, { id, displayName: f.config.registry.models[id].displayName,
      image: catalog.models.chat.find(model => model.id === id).image, webSearch: catalog.webSearch === 'live' });
  }
  delete f.definition.agent.description; delete f.definition.agent.starters; f.write();
  f.config.agent = new AgentDefinition(f.root, f.file);
  const response = await request(f.http, '/workbench', { token: f.bob });
  assert.equal(Object.hasOwn(response.body.agent, 'description'), false);
  assert.equal(Object.hasOwn(response.body.agent, 'starters'), false);
});

test('workbench 复用默认路由覆盖与搜索开关，不从请求选模型', async t => {
  const f = await service(t, { env: { CODEX_MODEL: 'zhipu/glm-5.3', ZHIPU_API_KEY: 'fixture-zhipu-secret', AGENT_WEB_SEARCH: 'off' } });
  const response = await request(f.http, '/workbench?model=kimi/kimi-k2.7-code', { token: f.bob });
  assert.deepEqual(response.body.defaultModel, { id: 'zhipu/glm-5.3', displayName: f.config.registry.models['zhipu/glm-5.3'].displayName, image: false, webSearch: false });
});

test('管理员 readiness 沿用认证、来源与限流，普通用户不能通过参数冒充管理员', async t => {
  const f = await service(t);
  assert.equal((await request(f.http, '/admin/readiness')).statusCode, 401);
  assert.equal((await request(f.http, '/admin/readiness?admin=true&role=admin', { token: f.bob, headers: { 'x-role': 'admin' } })).statusCode, 403);
  assert.equal((await request(f.http, '/admin/readiness', { token: f.alice, headers: { origin: 'https://other.example.com' } })).statusCode, 403);
  assert.equal((await request(f.http, '/admin/readiness', { token: f.alice })).statusCode, 200);
  // 使用同一个认证实例，确保限流请求经过真实 Accounts 的身份校验。
  const { accounts } = await accountFixture();
  const http = httpFixture(accounts, { config: { ...f.config, deployment: { rateLimit: 1 } } }); t.after(() => http.close());
  const { token } = await accounts.login({ username: 'alice', password: 'fixture-password' }, 'fixture');
  assert.equal((await request(http, '/admin/readiness', { token })).statusCode, 200);
  assert.equal((await request(http, '/admin/readiness', { token })).statusCode, 429);
  f.store.users.find(user => user.username === 'alice').role = 'user';
  assert.equal((await request(f.http, '/admin/readiness', { token: f.alice })).statusCode, 403);
  assert.equal((await request(f.http, '/workbench', { token: f.alice })).body.viewer.admin, false);
});

test('readiness 不读取宿主文件、全量备份与服务商 Key，响应不含任何夹具配置值或密钥', async t => {
  const f = await service(t);
  const response = await request(f.http, '/admin/readiness', { token: f.alice });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.unchecked.map(row => row.id), ['env-file', 'deployment-directory', 'default-model', 'fallback-model', 'backup']);
  for (const row of response.body.unchecked) { assert.equal(row.level, 'unchecked'); assert.equal(row.fix, '在服务器上运行 docker compose run --rm check 核对'); }
  assert.deepEqual(response.body.items.map(row => row.id), ['origins', 'budget', 'topology', 'agent']);
  assert.ok(response.body.items.every(row => row.level === 'ok'));
  const text = JSON.stringify(response.body);
  for (const value of [...Object.values(f.env), f.alice, f.bob, 'fixture-password', 'fixture-db-secret', 'fixture-redis-secret']) assert.equal(text.includes(value), false, '响应不得回显配置值或密钥');
});

test('CLI 与接口对同一输入共用纯判定，节点可检查项也逐项一致', async t => {
  const f = await service(t), now = Date.parse('2026-11-14T12:00:00Z');
  fs.writeFileSync(path.join(f.root, '.env'), Object.entries(f.env).map(([key, value]) => `${key}='${value}'\n`).join(''), { mode: 0o600 });
  const inputs = productionFileInputs({ root: f.root, now });
  const expected = checkProduction(inputs), node = await f.config.productionReadiness();
  assert.deepEqual(checkProductionFiles({ root: f.root, now }), expected.items);
  for (const row of node.items) assert.deepEqual(row, expected.items.find(item => item.id === row.id));
  f.config.productionReadiness = () => checkProduction(inputs);
  const response = await request(f.http, '/admin/readiness', { token: f.alice });
  assert.deepEqual(response.body, expected);
  assert.deepEqual(checkProduction(inputs), expected);
});

test('Compose 节点通过共享环境声明 HTTPS 信息，不挂载宿主 .env', () => {
  const compose = fs.readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  const node = compose.slice(compose.indexOf('environment: &node-env'), compose.indexOf('\n  node-b:'));
  for (const key of ['AGENT_DOMAIN', 'COMPOSE_PROFILES']) assert.ok(node.includes(`${key}: ${'${'}${key}:-}`));
  assert.doesNotMatch(node, /source: \.env|"\.\/\.env:/);
});
