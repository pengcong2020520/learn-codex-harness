import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordination, TTL, MEMBERS } from '../server/modules/coordination/index.mjs';
import { sharedLeaseElection } from '../server/modules/coordination/etcd.mjs';
import { ActiveService, clusterStatus } from '../server/modules/coordination/service.mjs';
import { fencePool, trackDispatch } from '../server/modules/coordination/fence.mjs';
import { nodeHandler } from '../server/modules/coordination/node.mjs';
import { runCluster } from '../client/cluster.mjs';
import { FakeClient, flush } from './fixtures/coordination-client.mjs';
async function fixture(t, options = {}) {
  const client = new FakeClient(); let time = 0;
  const c = new Coordination({ client, electionFactory: client.electionFactory, nodeId: 'node-a', address: 'http://node-a:4340',
    revision: 'revision-test', agentHash: 'hash-test', capacity: 4, now: () => time, ...options });
  t.after(() => c.close());
  await c.join(); await c.watchMembers();
  return { c, client, advance: ms => { time += ms; }, elect: async () => { const candidate = c.campaign(); candidate.elect(); await flush(); return candidate; } };
}
const rejected = error => error.code === 'NOT_CONTROLLER' && error.status === 409;

test('lease: TTL 10 grant + member metadata, expiration deletes registration and Watch observes', async t => {
  const { c, client } = await fixture(t);
  assert.deepEqual(client.operations[0], ['lease', 10]); assert.equal(TTL, 10);
  const member = c.members.get(MEMBERS + 'node-a');
  assert.equal(member.address, 'http://node-a:4340'); assert.equal(member.revision, 'revision-test');
  assert.equal(member.agentHash, 'hash-test'); assert.equal(member.capacity, 4); assert.ok(Date.parse(member.joinedAt));
  let lost = false; c.on('lost', () => { lost = true; }); c.lease.expire();
  assert.equal(c.members.size, 0); assert.equal(lost, true); assert.equal(c.isController(), false);
  assert.ok(c.events.some(e => e.type === 'member-left'));
});
test('watch: starts at snapshot revision + 1; etcd3 transport reconnect replaces cache with full snapshot', async t => {
  const { c, client } = await fixture(t); const w = c.watcher;
  assert.equal(w.revision, String(BigInt(c.memberRevision) + 1n));
  w.disconnect(); client.set(MEMBERS + 'node-b', JSON.stringify({ nodeId: 'node-b' }), '2');
  assert.equal(c.members.size, 1); w.reconnect(); await flush(); assert.equal(c.members.size, 2);
  assert.equal(client.operations.filter(op => op[0] === 'snapshot').length, 2);
  assert.equal(c.memberRevision, String(client.rev));
  w.emit('error', new Error('unrecoverable stream')); await flush();
  assert.equal(c.watcher.revision, String(client.rev + 1n));
});
test('watch: compacted revision reloads whole prefix and replaces stale members', async t => {
  const { c, client } = await fixture(t); const old = c.watcher; old.disconnect();
  client.remove(MEMBERS + 'node-a'); client.set(MEMBERS + 'node-c', JSON.stringify({ nodeId: 'node-c' }), '3');
  old.emit('error', new Error('etcdserver: mvcc: required revision has been compacted')); await flush();
  assert.equal(old.cancelled, true); assert.equal(c.members.size, 1); assert.ok(c.members.has(MEMBERS + 'node-c'));
  assert.equal(c.watcher.revision, String(client.rev + 1n));
  assert.equal(client.operations.filter(op => op[0] === 'snapshot').length, 2);
});
test('election: only etcd3 elected event activates; term is create revision, shared lease namespace adapter', async t => {
  const { c, client, elect } = await fixture(t);
  assert.equal(c.isController(), false); assert.equal(c.term(), null);
  await elect(); assert.equal(c.isController(), true);
  assert.equal(c.term(), client.kvs.get(c.electionKey).create_revision);
  const term = c.term(); await c.writeInfo(); const info = JSON.parse(client.kvs.get('/codex/cluster/info').value);
  assert.equal(info.term, term); assert.equal(info.members, 1); assert.ok(info.at);
  let used;
  class Election { constructor(parent, name, ttl) { used = { ns: parent.namespace('election/' + name + '/'), name, ttl }; } }
  const ns = { prefix: Buffer.from('/codex/controller/'), get() { return this.prefix; } };
  sharedLeaseElection({ namespace: prefix => { assert.equal(prefix, '/codex/controller/'); return ns; } }, c.lease, Election);
  assert.equal(used.ns.lease(10), c.lease); assert.equal(used.ttl, 10); assert.equal(used.ns.get(), ns.prefix);
});
test('fencing: expired term guardedPut is rejected by transaction; no old coordination write', async t => {
  const { c, client, elect } = await fixture(t); await elect();
  const term = c.term(); client.remove(c.electionKey); client.set(c.electionKey, c.nodeId, c.lease.id);
  assert.notEqual(client.kvs.get(c.electionKey).create_revision, term);
  await assert.rejects(c.guardedPut('/codex/cluster/info', 'stale'), rejected);
  assert.equal(client.kvs.has('/codex/cluster/info'), false); assert.equal(c.isController(), false);
  const txn = client.operations.filter(op => op[0] === 'if').at(-1);
  assert.deepEqual(txn.slice(2), ['Create', '==', term]);
});
test('shutdown: resign precedes revoke, membership disappears immediately; standby also revokes', async t => {
  const { c, client, elect } = await fixture(t); await elect(); await c.close();
  assert.equal(client.kvs.has(MEMBERS + 'node-a'), false);
  const operations = client.operations.map(op => op[0]); assert.ok(operations.indexOf('resign') < operations.indexOf('revoke'));
  assert.equal(operations.at(-1), 'close'); assert.equal(c.watcher.cancelled, true);
  const other = await fixture(t); await other.c.close(); assert.equal(other.client.kvs.size, 0);
});
test('isolation: KeepAlive success extends deadline, failures/late success past TTL never revive old lease', async t => {
  const { c, advance, elect } = await fixture(t); await elect();
  advance(9000); c.lease.emit('keepaliveSucceeded'); advance(9000); c.lease.emit('keepaliveFailed'); assert.equal(c.isController(), true);
  advance(1001); c.lease.emit('keepaliveSucceeded'); assert.equal(c.isController(), false);
  await assert.rejects(c.guardedPut('/codex/cluster/info', 'late'), rejected);
});
test('isolation: election error immediately closes admission before async teardown', async t => {
  const { c, elect } = await fixture(t); const candidate = await elect();
  candidate.emit('error', new Error('lost')); assert.equal(c.isController(), false);
});
test('service: standby starts no worker; election confirms before recovery and workers; loss stops dispatch', async t => {
  const { c, elect } = await fixture(t); const calls = []; let generation;
  const service = new ActiveService(c, async g => { generation = g; g.assert(); calls.push('recover-unconfirmed', 'wake-queued', 'workers');
    return { stopDispatch: () => calls.push('stop-dispatch'), close: async () => calls.push('mark-unconfirmed', 'close-pool') }; });
  assert.equal(service.isReady(), false); assert.deepEqual(calls, []);
  await elect(); await service.chain; assert.equal(service.isReady(), true);
  c.isolate('test'); assert.equal(service.isReady(), false); assert.equal(calls.at(-1), 'stop-dispatch');
  assert.throws(() => generation.assert(), rejected); await service.chain;
  assert.deepEqual(calls, ['recover-unconfirmed', 'wake-queued', 'workers', 'stop-dispatch', 'mark-unconfirmed', 'close-pool']);
});
test('service: lost during startup cannot publish readiness or resurrect old generation', async t => {
  const { c, elect } = await fixture(t); let release; let closed = 0;
  const service = new ActiveService(c, () => new Promise(resolve => { release = () => resolve({ close: async () => closed++ }); }), () => {});
  await elect(); c.isolate('during-start'); release(); await service.chain; await flush();
  assert.equal(service.isReady(), false); assert.equal(closed, 1);
});
test('isolation: /ready 503, HTTP not dispatched, pool and transaction refuse late results', async t => {
  const { c, elect, advance } = await fixture(t); let writes = 0, handled = 0, generation;
  const raw = { query: async () => { writes++; }, connect: async () => raw, release() {} };
  const service = new ActiveService(c, async g => { generation = g; return { http: { handle: async (_, res) => { handled++; res.writeHead(200); res.end('{}'); } }, stopDispatch() {}, close: async () => {} }; });
  await elect(); await service.chain;
  const pool = fencePool(raw, generation); const connection = await pool.connect(); await pool.query('UPDATE tasks');
  const response = () => ({ headersSent: false, writeHead(status) { this.status = status; }, end(value) { this.body = value; } });
  let res = response(); await nodeHandler(c, service, { nodeId: c.nodeId, cache: { revision: '1', shards: {}, slots: {} } })({ method: 'GET', url: '/ready', headers: {} }, res); assert.equal(res.status, 200);
  advance(10001); res = response(); await nodeHandler(c, service, { nodeId: c.nodeId, cache: { revision: '1', shards: {}, slots: {} } })({ method: 'GET', url: '/ready', headers: {} }, res);
  assert.equal(res.status, 503); assert.equal(handled, 1);
  assert.throws(() => pool.query('UPDATE tasks SET result=1'), rejected); assert.throws(() => connection.query('COMMIT'), rejected);
  assert.equal(writes, 4); await connection.query('ROLLBACK'); assert.equal(writes, 5); await service.chain;
});
test('recovery: old control marks only its dispatched task IDs, no global recovery after isolation', async () => {
  const queries = []; const jobs = { patch: async () => true }; const pool = { query: async (...args) => queries.push(args) };
  const recover = trackDispatch(jobs, pool, 'instance');
  await jobs.patch('old-task', { status: 'starting' }); await recover();
  assert.deepEqual(queries[0][1], ['instance', ['old-task']]); assert.match(queries[0][0], /status IN \('starting','running','steering'\)/);
});
test('cluster: admin only, member TTL, controller/term, last 20 events; CLI uses authenticated request', async t => {
  const { c, elect } = await fixture(t); await elect();
  for (let i = 0; i < 30; i++) c.record('test', { i });
  const accounts = role => ({ authenticate: async () => ({ role }) });
  await assert.rejects(clusterStatus(c, accounts('user'), 'token'), e => e.status === 403);
  const result = await clusterStatus(c, accounts('admin'), 'token');
  assert.equal(result.members[0].ttl, 10); assert.equal(result.control.nodeId, 'node-a'); assert.equal(result.control.term, c.term()); assert.equal(result.events.length, 20);
  await assert.rejects(clusterStatus(c, { authenticate: async () => { throw Object.assign(new Error(), { status: 401 }); } }), e => e.status === 401);
  assert.deepEqual(await runCluster(['status'], { request: async route => ({ route }) }), { route: '/cluster' });
  assert.throws(() => runCluster(['move'], {}), /用法/);
});

test('lease: failure event exceeding TTL isolates without another request; lost callback is synchronous', async t => {
  const { c, elect, advance } = await fixture(t); await elect(); let loss = 0;
  c.on('lost', () => loss++); advance(10001); c.lease.emit('keepaliveFailed');
  assert.equal(loss, 1); assert.equal(c.controller, false); assert.equal(c.lease.released, true);
  c.lease.emit('lost'); assert.equal(loss, 1);
});
test('service: a new lease rejoins as standby, then explicit elected restores a fresh generation', async t => {
  const { c, elect } = await fixture(t); const generations = []; let starts = 0;
  const service = new ActiveService(c, async generation => {
    starts++; generations.push(generation);
    return { stopDispatch() {}, close: async () => {} };
  });
  await elect(); await service.chain; const oldLease = c.lease;
  c.isolate('test'); await service.chain; await oldLease.revoke();
  await c.join(); assert.notEqual(c.lease, oldLease); assert.equal(c.isController(), false); assert.equal(starts, 1);
  await elect(); await service.chain; assert.equal(service.isReady(), true); assert.equal(starts, 2);
  assert.throws(() => generations[0].assert(), rejected); assert.doesNotThrow(() => generations[1].assert());
});
test('cluster: HTTP endpoint returns 401/403 without a user process and exposes TTL to admin', async t => {
  const { c, elect } = await fixture(t);
  let role = 'user'; const accounts = { authenticate: async auth => {
    if (!auth) throw Object.assign(new Error(), { status: 401 }); return { role };
  } };
  const service = new ActiveService(c, async () => ({ accounts, data: { scope: { instanceId: 'test' }, pool: { query: async () => ({ rows: [] }) } }, stopDispatch() {}, close: async () => {} }));
  await elect(); await service.chain;
  const request = async authorization => {
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await nodeHandler(c, service, { nodeId: c.nodeId, cache: { revision: '1', shards: {}, slots: {} } })({ method: 'GET', url: '/cluster', headers: { authorization } }, res); return res;
  };
  assert.equal((await request()).status, 401); assert.equal((await request('token')).status, 403);
  role = 'admin'; const res = await request('token'); assert.equal(res.status, 200); assert.equal(res.body.members[0].ttl, 10);
});

test('service: real MessageService recovery preserves queued and marks executing unconfirmed on election', async t => {
  const { MessageService } = await import('../server/modules/messages/index.mjs');
  const { EventEmitter } = await import('node:events');
  const { TestJobs } = await import('./jobs-fixture.mjs');
  const { c, elect } = await fixture(t);
  const store = new TestJobs({ jobs: [
    { id: 'running', threadId: 'one', status: 'running' },
    { id: 'queued', threadId: 'two', status: 'queued' },
  ], paused: [] });
  let messages, wakeups = 0;
  const service = new ActiveService(c, async generation => {
    const sessions = Object.assign(new EventEmitter(), { sessions: new Map() });
    const rpc = Object.assign(new EventEmitter(), { close: async () => {} });
    messages = new MessageService({ rpc, sessions, hub: { publish() {} }, config: { generation }, store,
      queue: { start() { wakeups++; }, close: async () => {} } });
    await messages.open();
    return { stopDispatch: () => { messages.stopping = true; }, close: () => messages.close() };
  });
  assert.equal(wakeups, 0); assert.equal(store.get('running').status, 'running');
  await elect(); await service.chain;
  assert.equal(store.get('running').status, 'unconfirmed'); assert.equal(store.get('queued').status, 'queued'); assert.equal(wakeups, 1);
  c.isolate('test'); assert.equal(messages.stopping, true);
  await messages.completed('one', { id: 'late', status: 'completed' });
  assert.equal(store.get('running').status, 'unconfirmed'); await service.chain;
});

test('service: shutdown while confirming term cancels activation before workers start', async t => {
  const { c, elect } = await fixture(t); await elect();
  let release, starts = 0;
  c.confirm = () => new Promise(resolve => { release = resolve; });
  const service = new ActiveService(c, async () => { starts++; return { stopDispatch() {}, close: async () => {} }; });
  c.emit('controller', c.term()); await flush();
  const stopped = service.stop(); release(); await stopped;
  assert.equal(starts, 0); assert.equal(service.isReady(), false);
});
