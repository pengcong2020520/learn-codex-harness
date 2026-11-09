import { nodeAuth, authHeaders } from './fixtures/node-auth.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { ShardControl } from '../server/modules/sharding/control.mjs';
import { ShardRuntime } from '../server/modules/sharding/runtime.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { defaultSlots, strategies } from '../server/modules/sharding/strategy.mjs';
import { requireIdentity, runIdentity } from '../server/modules/accounts/context.mjs';
import { FakeClient } from './fixtures/coordination-client.mjs';
import { scriptedCoordination } from './fixtures/sharding-cluster.mjs';
const user = '00000000-0000-4000-8000-000000000017';
const key = 'route-test-internal-key-123456789';

// HTTP streams in memory: run the real handler/forwarder without listening sockets.
async function request(handler, pathname, { method = 'GET', headers = {}, body } = {}) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { url: pathname, method, headers });
  const chunks = []; let status, responseHeaders;
  const res = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
  res.writeHead = (code, value) => { status = code; responseHeaders = value; res.headersSent = true; };
  res.flushHeaders = () => {};
  await handler(req, res);
  return new Response(Buffer.concat(chunks), { status, headers: responseHeaders });
}
async function fixture(t) {
  const client = new FakeClient(), members = new Map(), nodes = [], steps = [];
  client.set('/codex/slots', JSON.stringify(defaultSlots()));
  for (const [i, suffix] of ['a','b','c'].entries()) {
    client.set('/codex/shards/' + i, JSON.stringify({ primary: 'node-' + suffix, epoch: i + 1 }));
    members.set('/codex/members/node-' + suffix, { nodeId: 'node-' + suffix, address: `http://node-${suffix}` });
  }
  client.set('/codex/overrides/' + user, '"0"');
  const row = { user_id: user, shard_id: '0', paused: false };
  let operation, inTransaction = false, transactionTerm, termLocked = false;
  const db = { release() {}, async query(sql, args) {
    if (sql === 'BEGIN') { inTransaction = true; transactionTerm = undefined; termLocked = false; }
    if (sql.includes("set_config('app.term'")) { assert.ok(inTransaction); transactionTerm = args[0]; }
    if (sql === 'SELECT agent_data.locked_cluster_term()') { assert.equal(transactionTerm, '10'); termLocked = true; }
    if (/^(INSERT INTO|UPDATE) agent_data.move_operations/.test(sql)) {
      assert.ok(inTransaction && termLocked, 'operation writes must hold the control term transaction');
      steps.push('operation-' + (sql.startsWith('INSERT') ? 'paused' : args[2]));
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { inTransaction = false; transactionTerm = undefined; termLocked = false; }
    if (sql.startsWith('UPDATE agent_data.user_shards SET paused')) { row.paused = sql.includes('paused=true') ? true : sql.includes('paused=false') ? false : args[1]; steps.push('pg-paused-' + row.paused); }
    if (sql.startsWith('UPDATE agent_data.user_shards SET shard_id')) { row.shard_id = args[1]; steps.push('pg-shard-' + args[1]); }
    if (sql.startsWith('INSERT INTO agent_data.move_operations')) {
      operation = { id: args[0], user_id: args[1], from_shard: args[2], to_shard: args[3], control_node: args[4], source_node: args[5], target_node: args[6], state: 'paused' }; return { rows: [operation] };
    }
    if (sql.startsWith('UPDATE agent_data.move_operations SET state=$3')) { assert.equal(operation.state, args[1]); operation.state = args[2]; return { rows: [operation] }; }
    if (sql.startsWith('SELECT * FROM agent_data.move_operations')) return { rows: operation ? [operation] : [] };
    if (sql.startsWith('SELECT u.*')) return { rows: [{ ...row, node_id: 'node-a' }] };
    if (sql.startsWith('SELECT node_id')) return { rows: [{ node_id: 'node-b' }] };
    if (sql === 'COMMIT') steps.push('commit');
    return { rows: sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [{ ...row }] };
  } };
  const pool = { query: (sql, args) => {
    assert.doesNotMatch(sql, /^(INSERT INTO|UPDATE|DELETE FROM) agent_data.move_operations/, 'nodes only read operation orders');
    return db.query(sql, args);
  }, connect: async () => db };
  for (const suffix of ['a','b','c']) {
    const nodeId = 'node-' + suffix, cache = await new RouteCache(client).open();
    t.after(() => cache.close()); clearInterval(cache.timer);
    const coordination = scriptedCoordination({ client, nodeId, members, term: '10', isolations: [] });
    const runtime = new ShardRuntime({ nodeId, cache, coordination, ...nodeAuth(nodeId) }); runtime.pool = pool;
    const control = new ShardControl(coordination, cache, pool);
    const app = { data: { pool }, accounts: {
      authenticate: async token => ({ userId: user, role: token === 'Bearer admin' ? 'admin' : 'user' }),
      store: { byUsername: async name => name === 'dave' ? { id: user } : null },
    }, sessions: { atBoundary: async operation => { assert.equal(requireIdentity().userId, user); steps.push('boundary-' + nodeId); await operation(); } },
    http: { closeUserStreams: id => { assert.equal(id, user); steps.push('close-' + nodeId); },
      handle: async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ nodeId })); } },
    };
    const handler = createShardedHandler(coordination, { app, isReady: () => true }, runtime, control);
    const call = runtime.call;
    runtime.call = async (address, pathname, body) => {
      // Disk copying is covered by the UID suite; this case isolates route publication/admission.
      if (pathname === '/internal/drain') return { drained: true };
      if (pathname === '/internal/copy') return { copied: true };
      return call(address, pathname, body);
    };
    nodes.push({ runtime, cache, app, handler, control });
  }
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input), index = ['node-a','node-b','node-c'].indexOf(url.hostname);
    assert.ok(index >= 0);
    return request(nodes[index].handler, url.pathname + url.search, options);
  });
  const api = async (index, pathname, body, token = 'admin', method = body === undefined ? 'GET' : 'POST') => {
    const response = await request(nodes[index].handler, pathname, { method, headers: { authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { client, nodes, row, api, steps };
}

test('route diagnosis: admin only, each node cache/paused/PG/types; no refresh and partial failure', async t => {
  const { nodes, row, api } = await fixture(t);
  nodes[1].runtime.paused.add(user); row.paused = true;
  nodes[2].cache.overrides[user] = 2; // legacy numeric JSON, preserved in diagnostics
  const result = await api(0, '/cluster/route?username=dave');
  assert.equal(result.status, 200); assert.equal(result.body.nodes.length, 3);
  assert.deepEqual(result.body.nodes.map(node => node.nodeId), ['node-a', 'node-b', 'node-c']);
  assert.ok(result.body.nodes.every(node => !node.error), 'etcd member keys must resolve to member nodeId');
  const [a,b,c] = result.body.nodes;
  assert.equal(a.routeOf.shardId, '0'); assert.equal(a.pg.shard_id, '0'); assert.equal(a.canDispatch, false);
  assert.equal(b.localPaused, true); assert.equal(c.overrideType, 'number'); assert.equal(c.override, 2);
  assert.equal(c.routeShardIdType, 'string'); assert.equal(c.pgShardIdType, 'string'); assert.equal(c.shardMatches, false);
  assert.equal(nodes[2].cache.overrides[user], 2, 'diagnosis must not refresh away stale evidence');
  assert.equal((await api(0, '/cluster/route?username=dave', undefined, 'user')).status, 403);
  assert.equal((await api(0, '/cluster/route')).status, 400);
  assert.equal((await api(0, '/cluster/route?username=missing')).status, 404);
  assert.equal((await api(0, '/cluster/route?username=dave', {})).status, 405);
  const denied = await request(nodes[1].handler, '/internal/route', { method: 'POST', body: JSON.stringify({ userId: user }) });
  assert.equal(denied.status, 403);
  nodes[0].runtime.coordination.members.delete('/codex/members/node-c');
  const partial = await api(0, '/cluster/route?username=dave');
  assert.equal(partial.status, 200); assert.equal(partial.body.nodes[2].error.code, 'SHARD_UNAVAILABLE');
});

test('three nodes: production override bytes, delayed Watches, resume snapshot and immediate non-target entry returns 200', async t => {
  const { nodes, client, api, row, steps } = await fixture(t);
  // Drop Watch delivery on all nodes. refresh() must read authoritative etcd KV,
  // while third-node ingress remains stale until STALE_ROUTE triggers its retry.
  for (const node of nodes) node.cache.watcher.disconnected = true;
  const before = await api(2, '/cluster/route?username=dave');
  assert.deepEqual(before.body.nodes.map(n => n.routeOf.shardId), ['0','0','0']);
  const moved = await api(2, '/cluster/move', { username: 'dave', shardId: '1' });
  assert.equal(moved.status, 200, JSON.stringify(moved)); assert.equal(moved.body.from, '0');
  assert.equal(client.kvs.get('/codex/overrides/' + user).value.toString(), '"1"', 'wire value must be a JSON string');
  assert.deepEqual(row, { user_id: user, shard_id: '1', paused: false });
  const after = await api(2, '/cluster/route?username=dave');
  assert.deepEqual(after.body.nodes.map(n => n.routeOf.shardId), ['1','1','0']);
  assert.deepEqual(after.body.nodes.map(n => n.canDispatch), [false,true,false]);
  assert.equal(after.body.nodes[1].localPaused, false);
  const response = await api(2, '/sessions', undefined, 'user');
  assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.body.nodeId, 'node-b');
  assert.equal(nodes[2].cache.routeOf(user).shardId, '1');
  assert.ok(steps.indexOf('boundary-node-a') < steps.indexOf('pg-shard-1'));
  assert.ok(steps.indexOf('pg-shard-1') < steps.indexOf('pg-paused-false'));
  assert.deepEqual(steps.filter(step => step.startsWith('operation-')), ['operation-paused', 'operation-copying', 'operation-copied', 'operation-switched', 'operation-resumed']);
  t.diagnostic(JSON.stringify({ before: before.body, after: after.body, response }));
});

test('legacy numeric override: snapshot and Watch keep strict PG equality and override priority for both strategies', async t => {
  const { nodes, client, row } = await fixture(t);
  for (const value of [0,1,2]) {
    row.shard_id = String(value);
    client.set('/codex/overrides/' + user, String(value));
    for (const node of nodes) {
      for (const strategy of Object.values(strategies)) {
        node.cache.strategy = strategy;
        assert.equal(node.cache.routeOf(user).shardId, String(value));
      }
    }
    assert.equal(await nodes[value].runtime.canDispatch(user), true);
    await nodes[value].cache.refresh(); assert.equal(await nodes[value].runtime.canDispatch(user), true);
  }
  client.set('/codex/overrides/' + user, '{"bad":1}');
  assert.equal(nodes[0].cache.routeOf(user).primary, null, 'invalid override must not fall back to slots');
});

test('internal pause: migrating runOwner enters boundary, awaits it before closing streams, restores caller identity', { timeout: 5000 }, async t => {
  const { nodes, row, steps } = await fixture(t);
  const operation = await nodes[0].control.beginMove(user, '1'); steps.length = 0;
  let release, entered;
  const boundary = new Promise(resolve => { entered = resolve; });
  nodes[0].app.sessions.atBoundary = async operation => {
    assert.equal(requireIdentity().userId, user); entered();
    await new Promise(resolve => { release = resolve; }); await operation();
    assert.equal(requireIdentity().userId, user);
  };
  const adminId = '00000000-0000-4000-8000-000000000001';
  await runIdentity({ userId: adminId, role: 'admin' }, async () => {
    const pending = request(nodes[0].handler, '/internal/pause', { method: 'POST', headers: authHeaders('node-a'), body: JSON.stringify({ userId: user, operationId: operation.id }) });
    await boundary;
    assert.equal(nodes[0].runtime.paused.has(user), true); assert.equal(await nodes[0].runtime.canDispatch(user), false);
    assert.deepEqual(steps, []); release();
    assert.equal((await pending).status, 200); assert.deepEqual(steps, ['close-node-a']);
    assert.equal(requireIdentity().userId, adminId);
  });
});
