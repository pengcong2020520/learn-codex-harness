import { fixedAccounts } from './accounts-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHttpService } from '../server/modules/http/index.mjs';
import { createReadiness, RequestLimits, deploymentConfig, gracefulShutdown } from '../server/modules/deployment/index.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's15-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { root, launch: { router: {}, catalog: { models: [{}] } }, registry: {}, media: { endpoint: { baseUrl: 'http://gateway:8080/v1' } }, deployment: deploymentConfig() };
  const data = { pool: { query: async () => {} }, queue: { healthy: true } };
  const messages = {}, tools = {};
  return { config, data, messages, tools };
}
class Response extends EventEmitter {
  headers = {};
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); this.headersSent = true; }
  end(body) { this.body = body ? JSON.parse(body) : null; this.emit('close'); }
  flushHeaders() {}
  write() {}
}
async function request(http, url, authorization) {
  const response = new Response();
  await http.handle({ method: 'GET', url, headers: authorization ? { authorization } : {}, socket: { remoteAddress: '127.0.0.1' } }, response);
  return response;
}
test('ready: 网关、数据库、目录与关闭状态分别影响 503，health 只报告存活和版本', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.config.root, 'REVISION'), 'test-revision\n');
  let healthy = false;
  const ready = createReadiness({ ...f, fetcher: async () => ({ ok: healthy }) });
  const http = createHttpService({ ...f, accounts: fixedAccounts('test-token'), sessions: {}, hub: new EventEmitter(), redact: JSON.stringify, readiness: ready });
  let result = await request(http, '/ready');
  assert.equal(result.statusCode, 503); assert.equal(result.body.version, 'test-revision');
  assert.deepEqual((await request(http, '/health')).body, { status: 'alive', version: 'test-revision' });
  healthy = true;
  assert.equal((await request(http, '/ready')).statusCode, 200);
  f.data.pool.query = async () => { throw new Error('private database credential'); };
  result = await request(http, '/ready');
  assert.equal(result.statusCode, 503); assert.doesNotMatch(JSON.stringify(result.body), /credential/);
  f.data.pool.query = async () => {};
  f.config.registry = null;
  assert.equal((await request(http, '/ready')).statusCode, 503);
  f.config.registry = {}; f.messages.stopping = true;
  assert.equal((await request(http, '/ready')).statusCode, 503);
});
test('limits: 每分钟 120 次，Retry-After 秒数、来源隔离与窗口恢复', () => {
  let now = 0;
  const limits = new RequestLimits({ now: () => now });
  for (let i = 0; i < 120; i++) limits.request('token', 'peer');
  assert.throws(() => limits.request('token', 'peer'), e => e.status === 429 && e.retryAfter === 60);
  now = 1500;
  assert.throws(() => limits.request('token', 'peer'), e => e.retryAfter === 59);
  assert.throws(() => limits.request('token', 'other'), e => e.status === 429); limits.request('other', 'peer');
  limits.request(null, 'source-one'); limits.request(null, 'source-two');
  now = 60000; limits.request('token', 'peer');
});
test('limits: HTTP 层 429 和 Retry-After；health/ready 不扣额度；SSE 第 21 个拒绝并释放', async t => {
  const f = fixture(t);
  const hub = new EventEmitter(); hub.setMaxListeners(0); hub.since = () => []; hub.eventId = () => '0';
  const http = createHttpService({ ...f, accounts: fixedAccounts('test-token'), sessions: { ensure: async () => {} }, hub, redact: JSON.stringify,
    readiness: async () => ({ status: 'ready', version: 'dev' }) });
  for (let i = 0; i < 121; i++) { assert.equal((await request(http, '/health')).statusCode, 200); assert.equal((await request(http, '/ready')).statusCode, 200); }
  for (let i = 0; i < 120; i++) assert.equal((await request(http, '/missing', 'Bearer test-token')).statusCode, 404);
  const denied = await request(http, '/missing', 'Bearer test-token');
  assert.equal(denied.statusCode, 429); assert.equal(denied.headers['retry-after'], '60');
  http.limits.windows.clear();
  const connections = [];
  t.after(() => connections.forEach(r => r.end()));
  for (let i = 0; i < 20; i++) { const r = await request(http, '/events?threadId=test', 'Bearer test-token'); assert.equal(r.statusCode, 200); connections.push(r); }
  const full = await request(http, '/events?threadId=test', 'Bearer test-token');
  assert.equal(full.statusCode, 429);
  assert.equal(full.headers['retry-after'], '5');
  connections.pop().end();
  const next = await request(http, '/events?threadId=test', 'Bearer test-token'); assert.equal(next.statusCode, 200); connections.push(next);
  connections.forEach(r => r.end()); assert.equal(http.limits.sse, 0);
});
test('shutdown: 同步停止派发、先标待核对、后清理，截止时间固定 30 秒且幂等', async () => {
  const calls = []; let deadline;
  const close = gracefulShutdown({ stopDispatch: () => calls.push('stop'), markUnconfirmed: async () => calls.push('unconfirmed'), close: async () => calls.push('close'),
    timer: (fn, ms) => { assert.equal(ms, 30000); deadline = fn; return 1; }, clear: id => { assert.equal(id, 1); calls.push('clear'); }, exit: code => calls.push(code) });
  const first = close(); assert.equal(calls[0], 'stop'); assert.equal(close(), first); await first;
  assert.deepEqual(calls, ['stop', 'unconfirmed', 'close', 'clear']); deadline(); assert.equal(calls.at(-1), 1);
});
test('defaults: 所有部署数值固定且拒绝无效覆盖', () => {
  assert.deepEqual(deploymentConfig(), { maxConcurrentTurns: 2, maxQueued: 200, rateLimit: 120, maxSse: 20 });
  for (const key of ['AGENT_MAX_CONCURRENT_TURNS', 'AGENT_MAX_QUEUED', 'AGENT_RATE_LIMIT_PER_MINUTE', 'AGENT_MAX_SSE']) assert.throws(() => deploymentConfig({ [key]: '-1' }));
});
