import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { allowedOrigins, DEFAULT_ALLOWED_ORIGINS } from '../server/modules/config/origins.mjs';
import { accountFixture, httpFixture, request } from './accounts-fixture.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { forwardHeaders } from '../server/modules/sharding/routing.mjs';
import { fixture, installToolFixture, tempRoot } from './helpers.mjs';

test('Origin 配置：默认入口、显式端口与多个完整 origin；非法值启动报错', t => {
  assert.deepEqual(allowedOrigins({}), DEFAULT_ALLOWED_ORIGINS);
  assert.deepEqual(allowedOrigins({ AGENT_PORT: '9000' }), ['http://127.0.0.1:9000', 'http://localhost:9000']);
  assert.deepEqual(allowedOrigins({ AGENT_ALLOWED_ORIGINS: 'https://agent.example.com, http://localhost:8080,https://example.com:443' }), ['https://agent.example.com', 'http://localhost:8080', 'https://example.com']);
  const root = installToolFixture(tempRoot(t));
  assert.deepEqual(loadServerConfig(root, fixture).allowedOrigins, DEFAULT_ALLOWED_ORIGINS);
  for (const value of ['null', '*', 'ftp://example.com', 'https://example.com/', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com#x', 'https://user:pass@example.com', 'https://example.com,', 'https://', 'https://example.com:99999', 'https://example.com:', 'https://example.com\\path', 'https://exam\nple.com']) {
    assert.throws(() => loadServerConfig(root, { ...fixture, AGENT_ALLOWED_ORIGINS: value }), /AGENT_ALLOWED_ORIGINS/, value);
  }
});
test('Origin HTTP：CLI 与白名单放行；不信任 Host；无 CORS；网页登录记录 Web', async () => {
  const { accounts, store } = await accountFixture();
  const hints = [], create = store.createSession.bind(store);
  store.createSession = (user, session) => { hints.push(session.clientHint); return create(user, session); };
  const http = httpFixture(accounts, { config: { launch: {}, deployment: {}, allowedOrigins: DEFAULT_ALLOWED_ORIGINS } });
  const body = { username: 'alice', password: 'fixture-password', clientHint: 'forged' };
  for (const origin of [undefined, 'http://127.0.0.1:4317', 'http://localhost:4317']) {
    const headers = origin ? { origin } : {};
    assert.equal((await request(http, '/health', { headers })).statusCode, 200);
    const response = await request(http, '/auth/login', { headers, body });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.deepEqual(hints, ['CLI', 'Web', 'Web']);
  for (const origin of ['https://example.com', 'null', 'http://127.0.0.1:4318', 'http://127.0.0.1:4317/']) {
    const response = await request(http, '/auth/login', { headers: { origin, host: origin.replace(/^https?:\/\//, '') }, body });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error.message, '不允许的来源。网页访问请把入口地址加入 AGENT_ALLOWED_ORIGINS。');
  }
  await http.close();
});
test('Origin 节点转发：保留 Origin，两端按同一白名单校验', async () => {
  const { accounts } = await accountFixture();
  const config = { allowedOrigins: ['https://agent.example.com'], launch: {}, deployment: {} };
  const local = httpFixture(accounts, { config });
  const handler = createShardedHandler({}, { isReady: () => true, app: { config, http: local } }, {}, {});
  const http = { handle: handler };
  const forwarded = forwardHeaders({ origin: 'https://agent.example.com', host: 'arbitrary.example.com' }, { nodeId: 'node-a', key: 'test' }, { revision: '1' }, 'user');
  assert.equal(forwarded.origin, 'https://agent.example.com');
  const result = await request(http, '/auth/login', { headers: forwarded, body: { username: 'alice', password: 'fixture-password' } });
  assert.equal(result.statusCode, 200);
  assert.equal((await request(http, '/auth/login', { headers: { origin: 'https://example.com' }, body: {} })).statusCode, 403);
  await local.close();
});


test('修改 HTTP 路由：沿用认证和来源白名单，仅 POST 将请求交给消息层', async () => {
  const { accounts } = await accountFixture();
  const calls = [];
  const http = httpFixture(accounts, { config: { launch: {}, deployment: {}, allowedOrigins: DEFAULT_ALLOWED_ORIGINS },
    messages: { revise: async body => { calls.push(body); return { status: 'queued', step: 0, reviseCount: 1 }; } } });
  const { token } = await accounts.login({ username: 'alice', password: 'fixture-password' }, 'peer');
  const body = { threadId: 't', taskId: 'w', text: '简化布局' };
  assert.equal((await request(http, '/tasks/revise', { body })).statusCode, 401);
  assert.equal((await request(http, '/tasks/revise', { token, body, headers: { origin: 'https://untrusted.invalid' } })).statusCode, 403);
  assert.equal((await request(http, '/tasks/revise', { token })).statusCode, 404);
  assert.equal(calls.length, 0);
  for (const headers of [{}, { origin: 'http://localhost:4317' }]) {
    const response = await request(http, '/tasks/revise', { token, body, headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'queued', step: 0, reviseCount: 1 });
  }
  assert.deepEqual(calls, [body, body]);
  await http.close();
});
