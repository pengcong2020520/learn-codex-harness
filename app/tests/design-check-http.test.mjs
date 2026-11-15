import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCheckHandler, createCheckQueue } from '../server/design-check/service.mjs';
import { nodeHeaders, nodeKeyHash } from '../server/modules/sharding/node-auth.mjs';

test('design-check 真实 HTTP：节点认证、HTML 报告、排队超时与健康接口', async t => {
  const node = { nodeId: 'node-a', key: 'design-http-fixture-key-not-real' };
  const check = createCheckQueue({ timeoutMs: 30, run: async ({ html }, signal) => {
    if (html === 'timeout') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return { status: 'completed', errors: 0, warnings: 0, issues: [] };
  } });
  const server = createServer(createCheckHandler({ keyHashes: { 'node-a': nodeKeyHash(node.key) }, check }));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (html, headers = nodeHeaders(node)) => fetch(`${base}/check`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ html }) });
  const denied = await post('clean', {}); assert.equal(denied.status, 403); await denied.body.cancel();
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  const timed = await post('timeout'); assert.equal(timed.status, 504); assert.equal((await timed.json()).error, '检查超时');
  const clean = await post('clean'); assert.equal(clean.status, 200); assert.equal((await clean.json()).errors, 0);
});
