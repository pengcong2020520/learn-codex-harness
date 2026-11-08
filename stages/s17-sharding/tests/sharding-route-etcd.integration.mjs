// Dedicated test PG/Redis + authenticated etcd only. Never point these at production.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { connectEtcd } from '../server/modules/coordination/etcd.mjs';
import { Coordination } from '../server/modules/coordination/index.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { defaultSlots } from '../server/modules/sharding/strategy.mjs';
import { openDatabase, migrate, identity } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser } from '../server/modules/accounts/admin.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
import { startClusterNode } from './fixtures/sharding-cluster.mjs';
import { tempRoot, cleanup, installToolFixture, until } from './helpers.mjs';
import { responsesFixture, answer } from './responses-fixture.mjs';

const required = ['ETCD_TEST_ENDPOINT', 'ETCD_TEST_NODE_A_PASSWORD', 'ETCD_TEST_NODE_B_PASSWORD', 'ETCD_TEST_NODE_C_PASSWORD', 'DATA_TEST_DATABASE_URL', 'DATA_TEST_REDIS_URL'];
const missing = required.filter(name => !process.env[name]);
test('authenticated etcd + PG: three nodes migrate via non-target ingress, immediate GET /sessions 200 with route diagnostics', {
  skip: missing.length ? 'missing test environment: ' + missing.join(', ') : false, timeout: 120000,
}, async t => {
  const root = tempRoot(t); fs.chmodSync(root, 0o755);
  // The Linux UID suite owns DAC/ownership assertions. Still clean private files as owner.
  if (process.platform === 'linux' && process.getuid() === 0) cleanup(root, () => {
    const allowCleanup = dir => {
      if (!fs.lstatSync(dir).isDirectory()) return;
      fs.chownSync(dir, 0, process.getgid()); fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) allowCleanup(path.join(dir, name));
    };
    allowCleanup(root);
  });
  const roots = ['a','b','c'].map(s => installToolFixture(path.join(root, s)));
  const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
  const admin = await openDatabase(databaseUrl, { maintenance: true }); cleanup(root, () => admin.end()); await migrate(admin);
  const password = 'route-etcd-test-password';
  await provisionNodeRoles(admin, { a: password, b: password, c: password }, (await admin.query('SELECT current_database() AS db')).rows[0].db);
  const scope = identity(roots[0]);
  for (const nodeRoot of roots.slice(1)) {
    fs.mkdirSync(path.join(nodeRoot, '.data'), { recursive: true });
    fs.writeFileSync(path.join(nodeRoot, '.data/identity.json'), JSON.stringify(scope));
  }
  const accounts = new AccountStore(admin, scope.instanceId);
  const owner = await initializeAccounts(accounts, { ownerId: scope.ownerId, username: 'admin', password, workspace: path.join(roots[0], 'workspace') });
  const dave = await addUser(accounts, { username: 'dave', password });
  const coordinators = [], servers = [];
  for (const suffix of ['a','b','c']) {
    const server = createServer(); servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanup(root, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const adapter = await connectEtcd(process.env.ETCD_TEST_ENDPOINT, {
      username: 'node-' + suffix, password: process.env[`ETCD_TEST_NODE_${suffix.toUpperCase()}_PASSWORD`],
    });
    const c = new Coordination({ ...adapter, nodeId: 'node-' + suffix, address: `http://127.0.0.1:${server.address().port}` });
    cleanup(root, () => c.close()); coordinators.push(c); await c.join(); await c.watchMembers();
  }
  // Predictable control, but real lease/election/guarded transaction/authentication.
  coordinators[0].campaign(); await until(() => coordinators[0].isController(), 10000);
  coordinators[1].campaign(); coordinators[2].campaign();
  await until(() => coordinators.every(c => c.members.size === 3), 10000);
  const leader = coordinators[0], term = leader.term();
  const pgTerm = (await admin.query('SELECT term FROM agent_data.cluster_term WHERE id=1')).rows[0].term;
  assert.ok(BigInt(term) >= BigInt(pgTerm), 'use a matching dedicated test PG/etcd pair; PG fencing term must not be ahead of etcd election');
  await leader.guardedPut('/codex/slots', defaultSlots());
  for (const [i, c] of coordinators.entries()) {
    await leader.guardedPut('/codex/shards/' + i, { primary: c.nodeId, epoch: 1 });
    await admin.query(`INSERT INTO agent_data.shard_owners VALUES($1,$2,1)
      ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch`, [String(i), c.nodeId]);
  }
  for (const user of [owner, dave]) {
    await leader.guardedPut('/codex/overrides/' + user.id, '"0"');
    await admin.query("INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,'0')", [user.id]);
  }
  const provider = await responsesFixture(root, () => answer('unused model fixture'));
  const nodes = [], logs = [], isolations = [];
  for (const [index, coordination] of coordinators.entries()) {
    const cache = await new RouteCache(coordination.client).open(); cleanup(root, () => cache.close());
    const routeOf = cache.routeOf.bind(cache);
    cache.routeOf = id => [owner.id, dave.id].includes(id) ? routeOf(id) : { shardId: null, primary: null, epoch: null, revision: cache.revision };
    nodes.push(await startClusterNode({ root, nodeRoot: roots[index], databaseUrl, redisUrl, password, provider, cache, coordination, term, logs, isolations, server: servers[index] }));
  }
  // Real reverse-proxy hop, pinned to non-target node-c (no direct target requests).
  const ingress = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const upstream = await fetch(nodes[2].address + req.url, { method: req.method, headers: { authorization: req.headers.authorization || '', 'content-type': 'application/json' },
        ...(['GET','HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => ingress.listen(0, '127.0.0.1', resolve));
  cleanup(root, () => new Promise(resolve => { ingress.close(resolve); ingress.closeAllConnections(); }));
  const api = async (pathname, body, token) => {
    const response = await fetch(`http://127.0.0.1:${ingress.address().port}` + pathname, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    return { status: response.status, body: await response.json() };
  };
  const login = async username => {
    const result = await api('/auth/login', { username, password }); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.token;
  };
  const adminToken = await login('admin'), token = await login('dave');
  const diagnosis = () => api('/cluster/route?username=dave', undefined, adminToken);
  const before = await diagnosis(); assert.equal(before.status, 200);
  assert.deepEqual(before.body.nodes.map(n => n.routeOf.shardId), ['0','0','0']);
  const moved = await api('/cluster/move', { username: 'dave', shardId: '1' }, adminToken);
  assert.equal(moved.status, 200, JSON.stringify({ moved, logs }));
  assert.equal(moved.body.from, '0'); assert.equal(moved.body.shardId, '1');
  // No polling/diagnostic refresh or delay between move response and the user request.
  const sessions = await api('/sessions', undefined, token);
  const after = await diagnosis();
  assert.equal(sessions.status, 200, JSON.stringify({ sessions, before, after, logs }));
  assert.equal(after.status, 200); assert.equal(after.body.nodes.length, 3);
  for (const node of after.body.nodes) {
    assert.equal(node.routeOf.shardId, '1'); assert.equal(node.routeOf.primary, 'node-b');
    assert.equal(node.overrideType, 'string'); assert.equal(node.localPaused, false);
    assert.equal(node.pg.shard_id, '1'); assert.equal(node.pg.paused, false);
    assert.equal(node.canDispatch, node.nodeId === 'node-b');
  }
  const wire = await leader.client.get('/codex/overrides/' + dave.id).exec();
  assert.equal(wire.kvs[0].value.toString(), '"1"');
  assert.deepEqual(isolations, []);
  assert.equal(logs.some(line => /\[(SH001|CT001)\]/.test(line)), false);
  t.diagnostic(JSON.stringify({ before: before.body, moved: moved.body, sessionsStatus: sessions.status, after: after.body }));
});
