import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Etcd3 } from 'etcd3';
import { Coordination } from '../server/modules/coordination/index.mjs';
import { connectEtcd, sharedLeaseElection } from '../server/modules/coordination/etcd.mjs';
import { normalizePrefix } from '../server/modules/coordination/keys.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { ReplicationControl } from '../server/modules/replication/control.mjs';
import { defaultSlots } from '../server/modules/sharding/strategy.mjs';
import { FakeClient, flush } from './fixtures/coordination-client.mjs';

test('rejoin: installed etcd3 Watch manager has no orphan or reconnect loop after close', async () => {
  const client = new FakeClient(), transport = new Etcd3();
  const watchers = [], streams = [];
  let closed = false, attempts = 0, id = 0;
  // Exercise etcd3's real Watch/AttachQueue/cancellation state machine offline.
  transport.watchClient.watch = async () => {
    attempts++;
    if (closed) throw new Error('transport already closed');
    const stream = new EventEmitter(); streams.push(stream);
    stream.cancel = () => queueMicrotask(() => stream.emit('end'));
    stream.write = request => queueMicrotask(() => stream.emit('data', request.create_request
      ? { created: true, watch_id: String(++id), header: { revision: '1' } }
      : { canceled: true, watch_id: request.cancel_request.watch_id, header: { revision: '1' } }));
    return stream;
  };
  client.watch = () => {
    const builder = transport.watch(), create = builder.watcher.bind(builder);
    builder.watcher = () => { const watcher = create(); watchers.push(watcher); return watcher; };
    return builder;
  };
  client.close = () => { closed = true; for (const stream of streams) stream.emit('end'); transport.close(); };
  const c = new Coordination({ client, electionFactory: client.electionFactory, nodeId: 'node-a' });
  let ended = 0;
  try {
    await c.join(); await c.watchMembers(); await flush();
    watchers[0].on('end', () => ended++);
    c.lease.release(); c.checkLease();
    // Also cover callers that forget leaveGeneration: replacing a Watch is safe.
    await c.join(); await c.watchMembers(); await flush();
    watchers[1].on('end', () => ended++);
    await c.close();
    assert.equal(ended, 2, 'both old and current Watch must be cancelled before transport closes');
    const atClose = attempts;
    await delay(30);
    assert.equal(attempts, atClose, 'closed transport must not be retried');
  } finally {
    // Keep a failed regression from reproducing an infinite reconnect in npm test.
    await Promise.all(watchers.map(w => w.cancel()));
    transport.close();
  }
});

test('prefix isolates members, election, routes and replication publication on shared keys', async t => {
  const client = new FakeClient(); client.keyPrefix = '/codex/tests/one/';
  client.set('/codex/members/node-b', JSON.stringify({ nodeId: 'node-b' }));
  client.set('/codex/tests/two/members/node-c', JSON.stringify({ nodeId: 'node-c' }));
  client.set('/codex/shards/0', JSON.stringify({ primary: 'production', epoch: 99 }));
  client.set('/codex/tests/two/shards/0', JSON.stringify({ primary: 'other-test', epoch: 99 }));
  const c = new Coordination({ client, nodeId: 'node-a' });
  const cache = new RouteCache(client);
  t.after(async () => { await cache.close(); await c.close(); });
  await c.join(); await c.watchMembers(); await cache.open();
  assert.deepEqual([...c.members.values()].map(m => m.nodeId), ['node-a']);
  assert.deepEqual(cache.shards, {});
  const key = client.keyPrefix + 'controller/test';
  const kv = client.set(key, c.nodeId, c.lease.id);
  Object.assign(c, { electionKey: key, ownTerm: kv.create_revision, controller: true });
  await c.writeInfo();
  assert.ok(client.kvs.has(client.keyPrefix + 'cluster/info'));
  let namespace;
  sharedLeaseElection({ keyPrefix: client.keyPrefix, namespace: prefix => {
    namespace = prefix; return {};
  } }, c.lease, class { constructor(parent) { parent.namespace('ignored'); } });
  assert.equal(namespace, client.keyPrefix + 'controller/');
  const row = { shard_id: '0', node_id: 'node-a', replica: 'node-b', epoch: 1, publishing: false };
  const ctl = new ReplicationControl(c, cache, { query: async () => ({ rows: [row] }) }, 'test-instance', ['node-a','node-b','node-c']);
  ctl.locked = async operation => operation({ query: async () => ({ rows: [] }) });
  await ctl.publish();
  await c.guardedPut(client.keyPrefix + 'overrides/user', '"0"');
  assert.equal(cache.routeOf('user').primary, 'node-a');
  assert.deepEqual(cache.slots, defaultSlots());
  assert.equal(JSON.parse(client.kvs.get('/codex/shards/0').value).primary, 'production');
  client.set('/codex/tests/two/overrides/user', '"2"');
  assert.equal(cache.overrides.user, '0');
});

test('adapter retains default prefix; RPC/auth deadlines exclude long-lived streams', async () => {
  const { client } = await connectEtcd('http://unused.invalid:2379', { username: 'node-a', password: 'fixture' });
  try {
    assert.equal(client.keyPrefix, '/codex/');
    const options = client.options;
    const now = Date.now();
    assert.ok(options.defaultCallOptions({ isStream: false }).deadline >= now + 2900);
    assert.deepEqual(options.defaultCallOptions({ isStream: true }), {});
    assert.ok(options.auth.callOptions().deadline >= now + 2900);
    assert.equal(normalizePrefix('/codex/tests/one/'), '/codex/tests/one/');
    for (const value of ['/', '', '/codex', 'relative/', '/codex//']) assert.throws(() => normalizePrefix(value));
  } finally { client.close(); }
});

test('integration deadline fails the process with the stuck cleanup phase', () => {
  const helper = new URL('./fixtures/etcd-test-scope.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import test from 'node:test';
    import { etcdTestScope } from ${JSON.stringify(helper)};
    test('blocked cleanup', async t => {
      const scope = etcdTestScope(t, 'watchdog-regression', 150);
      scope.defer('stalled lease revoke', () => new Promise(() => {}));
    });
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hard timeout.*stuck at: cleanup: stalled lease revoke/);
});
