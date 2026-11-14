import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFixture, fixedAccounts, httpFixture, request } from './accounts-fixture.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';

test('HTTP JSON：成功与 404 响应均禁止内容类型嗅探', async t => {
  const http = httpFixture(fixedAccounts());
  t.after(() => http.close());
  for (const [url, status] of [['/health', 200], ['/missing', 404]]) {
    const response = await request(http, url, { token: 'unit-token' });
    assert.equal(response.statusCode, status);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});

test('HTTP JSON：登录成功响应禁止内容类型嗅探', async t => {
  const { accounts } = await accountFixture();
  const http = httpFixture(accounts);
  t.after(() => http.close());
  const response = await request(http, '/auth/login', { body: { username: 'alice', password: 'fixture-password' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('分片 HTTP JSON：成功与来源拒绝响应均禁止内容类型嗅探', async () => {
  const config = { allowedOrigins: ['https://example.com'] };
  const http = { handle: createShardedHandler({}, { app: { config }, isReady: () => true }, {}, {}) };
  for (const [headers, status] of [[{}, 200], [{ origin: 'https://untrusted.example.com' }, 403]]) {
    const response = await request(http, '/health', { headers });
    assert.equal(response.statusCode, status);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});
