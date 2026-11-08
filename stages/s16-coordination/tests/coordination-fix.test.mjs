import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Coordination, MEMBERS } from '../server/modules/coordination/index.mjs';
import { ActiveService } from '../server/modules/coordination/service.mjs';
import { Rejoin } from '../server/modules/coordination/rejoin.mjs';
import { fencePool, advanceTerm } from '../server/modules/coordination/fence.mjs';
import { FakeClient, flush } from './fixtures/coordination-client.mjs';
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
async function fixture(t) {
  const client = new FakeClient();
  const c = new Coordination({ client, electionFactory: client.electionFactory, nodeId: 'node-a' });
  t.after(() => c.close()); await c.join(); await c.watchMembers();
  return { c, client, elect: async () => { c.campaign().elect(); await flush(); } };
}
test('PG: CT001 rejects stale writes and synchronously isolates the active generation', async t => {
  const { c, elect } = await fixture(t); let generation;
  const service = new ActiveService(c, async g => { generation = g; return { stopDispatch() {}, close: async () => {} }; });
  await elect(); await service.chain;
  const calls = [];
  const raw = { connect: async () => raw, release() {}, query: async sql => {
    calls.push(sql); if (sql.startsWith('UPDATE')) throw Object.assign(new Error('stale'), { code: 'CT001' });
  } };
  await assert.rejects(fencePool(raw, generation).query('UPDATE agent_data.tasks SET status=\'failed\''), { code: 'CT001' });
  assert.equal(service.isReady(), false); assert.equal(c.alive, false);
  assert.match(calls[1], /^SET LOCAL app.term = '\d+'$/); assert.equal(calls.at(-1), 'ROLLBACK');
  await service.chain;
});
test('PG: promotion precedes recovery, rejects higher stored term, supports explicit transactions', async () => {
  const calls = []; let isolated = false;
  const generation = { term: '42', assert() {}, isolate() { isolated = true; } };
  const client = { query: async (...args) => { calls.push(args); }, release() {} };
  const raw = { ...client, connect: async () => client };
  await advanceTerm(raw, generation);
  assert.deepEqual(calls.shift(), ['SELECT agent_data.advance_cluster_term($1::bigint)', ['42']]);
  const pool = fencePool(raw, generation), connection = await pool.connect();
  await connection.query('BEGIN'); await connection.query('UPDATE agent_data.tasks SET status=\'failed\''); await connection.query('COMMIT');
  assert.deepEqual(calls.map(c => c[0]), ['BEGIN', "SET LOCAL app.term = '42'", "UPDATE agent_data.tasks SET status='failed'", 'COMMIT']);
  await assert.rejects(advanceTerm({ query: async () => { throw Object.assign(new Error(), { code: 'CT001' }); } }, generation));
  assert.equal(isolated, true);
  const source = read('server/modules/data/index.mjs');
  assert.ok(source.indexOf('await advanceTerm') < source.indexOf('new Repository'));
});
test('PG: migration covers every business table; maintenance checks invoker role; node cannot update singleton', () => {
  const sql = read('server/modules/data/migrations/015-cluster-term.sql');
  assert.match(sql, /tablename NOT IN \('migrations','cluster_term'\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE/);
  assert.match(sql, /rolname=current_user AND rolsuper/);
  assert.match(sql, /actual IS NULL OR supplied <> actual::text/);
  assert.match(sql, /FOR SHARE/); assert.match(sql, /ERRCODE='CT001'/);
  assert.match(read('scripts/cluster-migrate.mjs'), /REVOKE INSERT, UPDATE, DELETE ON agent_data.cluster_term/);
});
test('executionError cannot replace an already unconfirmed result', async () => {
  const { MessageService } = await import('../server/modules/messages/index.mjs');
  const { TestJobs } = await import('./jobs-fixture.mjs');
  const store = new TestJobs({ jobs: [{ id: 'job', threadId: 'thread', status: 'unconfirmed' }], paused: [] });
  const service = { store };
  await MessageService.prototype.executionError.call(service, store.get('job'), Object.assign(new Error('old rejection'), { code: -1 }), true);
  assert.equal(store.get('job').status, 'unconfirmed');
});
test('Watch: every connection replaces cache, periodic reconciliation corrects members and control', async t => {
  const { c, client, elect } = await fixture(t); await elect();
  c.members.set('ghost', { nodeId: 'ghost' }); c.watcher.emit('connected'); await flush();
  assert.equal(c.members.has('ghost'), false);
  c.watcher.disconnect(); client.remove(MEMBERS + 'node-a');
  client.set(MEMBERS + 'node-b', JSON.stringify({ nodeId: 'node-b' }), '22');
  c.observedControl = { nodeId: 'wrong', term: '0' };
  await c.reconcile();
  assert.deepEqual([...c.members.keys()], [MEMBERS + 'node-b']);
  assert.equal(c.observedControl.nodeId, 'node-a');
  assert.ok(c.events.some(e => e.type === 'members-reconciled'));
  assert.ok(c.events.some(e => e.type === 'control-reconciled'));
  assert.equal(c.reconcileTimer._idleTimeout, 5000);
});
test('Watch: compact_revision without error text reloads; bad member JSON is logged and ignored', async t => {
  const { c, client } = await fixture(t); const previous = c.watcher;
  client.set(MEMBERS + 'node-b', '{bad', '22'); assert.equal(c.members.size, 1);
  previous.emit('data', { compact_revision: '123', events: [] }); await flush();
  assert.notEqual(c.watcher, previous); assert.equal(previous.cancelled, true);
  assert.equal(c.members.size, 1); assert.ok(c.events.some(e => e.type === 'member-invalid'));
  assert.ok(c.events.some(e => e.type === 'watch-compacted'));
});
test('rejoin waits for stop, obtains a fresh lease, and ignores old lease/campaign/watch callbacks', async t => {
  const { c, elect } = await fixture(t); let finishStop; const generations = [];
  const service = new ActiveService(c, async g => { generations.push(g); return { stopDispatch() {}, close: () => new Promise(resolve => { finishStop = resolve; }) }; });
  await elect(); await service.chain;
  const oldLease = c.lease, oldWatch = c.watcher, oldCandidate = c.candidate;
  const rejoin = new Rejoin(c, service); t.after(() => rejoin.close());
  c.isolate('test'); await flush();
  assert.equal(c.lease, oldLease); assert.equal(service.isReady(), false);
  finishStop(); await rejoin.pending;
  assert.notEqual(c.lease, oldLease); assert.equal(c.alive, true); assert.equal(service.isReady(), false);
  oldLease.emit('lost'); oldLease.emit('keepaliveSucceeded'); oldLease.emit('keepaliveFailed');
  oldCandidate.emit('error', new Error('delayed')); oldCandidate.emit('elected');
  oldWatch.emit('data', { events: [{ type: 'Delete', kv: { key: Buffer.from(MEMBERS + 'node-a'), mod_revision: '999' } }] });
  await flush(); assert.equal(c.alive, true); assert.equal(c.controller, false); assert.equal(c.members.size, 1);
  assert.throws(() => generations[0].assert(), { code: 'NOT_CONTROLLER' });
  await rejoin.close();
});
test('rejoin failures back off 2s, 4s, 8s, 16s, 30s and cap at 30s', async t => {
  const { c } = await fixture(t); c.isolate('setup');
  const join = c.join.bind(c); let attempts = 0; const delays = [], order = [];
  c.join = async () => { order.push('join'); if (++attempts <= 6) throw new Error('temporary'); return join(); };
  const rejoin = new Rejoin(c, { stop: async () => order.push('stop') }, { sleep: async ms => delays.push(ms) });
  t.after(() => rejoin.close()); await rejoin.run();
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(order[0], 'stop'); assert.equal(c.alive, true); assert.equal(c.controller, false);
});
test('stop failure never permits automatic rejoin', async t => {
  const { c, elect } = await fixture(t);
  const service = new ActiveService(c, async () => ({ stopDispatch() {}, close: async () => { throw new Error('child still alive'); } }), () => {});
  await elect(); await service.chain; const old = c.lease;
  let rejoin;
  rejoin = new Rejoin(c, service, { sleep: async () => { rejoin.closed = true; } });
  c.isolate('test'); await rejoin.pending;
  assert.equal(c.lease, old); assert.equal(c.alive, false); assert.equal(service.isReady(), false);
  await rejoin.close();
});
test('deployment uses per-node etcd auth, Redis requirepass, no etcd host port', () => {
  const compose = read('compose.yaml');
  for (const suffix of ['A','B','C']) assert.match(compose, new RegExp(`ETCD_PASSWORD: \\$\\{ETCD_NODE_${suffix}_PASSWORD`));
  assert.match(compose, /--requirepass/); assert.match(compose, /REDISCLI_AUTH/);
  assert.doesNotMatch(compose.split('  etcd:\n')[1].split('  caddy:')[0], /ports:/);
  assert.match(read('server/modules/coordination/node.mjs'), /password: env.ETCD_PASSWORD/);
  assert.match(read('scripts/etcd-init.mjs'), /Range.prefix\('\/codex\/'\)/);
});
test('Watch preserves all member changes sharing one transaction revision', async t => {
  const { c } = await fixture(t);
  c.watcher.emit('data', { events: ['node-b','node-c'].map(nodeId => ({ type: 'Put', kv: {
    key: Buffer.from(MEMBERS + nodeId), value: Buffer.from(JSON.stringify({ nodeId })), lease: '2', mod_revision: '20',
  } })) });
  assert.equal(c.members.size, 3);
});
test('delayed confirmation from old generation cannot isolate newly elected generation', async t => {
  const { c, client, elect } = await fixture(t); await elect();
  const realIf = client.if.bind(client); let release;
  client.if = () => ({ then: () => ({ commit: () => new Promise(resolve => { release = resolve; }) }) });
  const pending = assert.rejects(c.confirm(), { code: 'NOT_CONTROLLER' });
  c.isolate('pause'); await c.leaveGeneration(); await c.join(); await c.watchMembers();
  client.if = realIf; await elect(); release({ succeeded: false }); await pending;
  assert.equal(c.isController(), true);
});
test('CT001 isolates admission before waiting for a slow rollback', async () => {
  let isolated = false, finishRollback;
  const raw = { connect: async () => raw, release() {}, query: async sql => {
    if (sql === 'UPDATE agent_data.tasks SET error=NULL') throw Object.assign(new Error('stale'), { code: 'CT001' });
    if (sql === 'ROLLBACK') await new Promise(resolve => { finishRollback = resolve; });
  } };
  const pool = fencePool(raw, { term: '1', assert() {}, isolate: () => { isolated = true; } });
  const rejected = assert.rejects(pool.query('UPDATE agent_data.tasks SET error=NULL'), { code: 'CT001' });
  await flush(); assert.equal(isolated, true); finishRollback(); await rejected;
});
