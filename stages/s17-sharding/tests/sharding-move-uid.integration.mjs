// Real Linux credentials, PG node roles, Redis, HTTP migration and native Codex.
// Only etcd membership/leases and the model endpoint are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { startAgentServer } from '../server/main.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { identity, migrate, openDatabase } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser } from '../server/modules/accounts/admin.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { readAsUser } from '../server/modules/runtimes/user-files.mjs';
import { ShardRuntime } from '../server/modules/sharding/runtime.mjs';
import { ShardControl } from '../server/modules/sharding/control.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { defaultSlots } from '../server/modules/sharding/strategy.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
import { cleanup, installToolFixture, tempRoot, until } from './helpers.mjs';
import { answer, responsesFixture } from './responses-fixture.mjs';
import { FakeClient } from './fixtures/coordination-client.mjs';

test('Linux 双节点完整迁移：私有 home/tmp、服务 workspace、续聊、停止旧主派发与 SH001', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 ? '需要 Linux 0:1000 与真实 PG/Redis' : false,
  timeout: 180000,
}, async t => {
  assert.equal(process.getgid(), 1000, '使用 --user 0:1000');
  const caps = BigInt('0x' + fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s+(\w+)/m)[1]);
  assert.equal(caps, [0n, 3n, 6n, 7n].reduce((n, bit) => n | (1n << bit), 0n), '仅 CHOWN/FOWNER/SETGID/SETUID，不允许 DAC 能力');
  const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
  assert.ok(databaseUrl && redisUrl, '设置专用 DATA_TEST_DATABASE_URL 与 DATA_TEST_REDIS_URL；禁止生产库');
  const root = tempRoot(t); fs.chmodSync(root, 0o755);
  const roots = ['node-a', 'node-b'].map(name => installToolFixture(path.join(root, name)));
  // tempRoot removes the fixture after closing apps; private directories need CHOWN,
  // not DAC, to make that final cleanup possible. Never follow the node_modules link.
  cleanup(root, () => {
    const allowCleanup = dir => {
      if (!fs.lstatSync(dir).isDirectory()) return;
      fs.chownSync(dir, 0, 1000); fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) allowCleanup(path.join(dir, name));
    };
    allowCleanup(root);
  });
  const admin = await openDatabase(databaseUrl, { maintenance: true }); cleanup(root, () => admin.end());
  await migrate(admin);
  const password = 'sharding-move-fixture-password';
  await provisionNodeRoles(admin, { a: password, b: password, c: password }, (await admin.query('SELECT current_database() AS db')).rows[0].db);
  const scope = identity(roots[0]);
  fs.mkdirSync(path.join(roots[1], '.data'), { recursive: true });
  fs.writeFileSync(path.join(roots[1], '.data/identity.json'), JSON.stringify(scope));
  const accounts = new AccountStore(admin, scope.instanceId);
  const owner = await initializeAccounts(accounts, { ownerId: scope.ownerId, username: 'admin', password, workspace: path.join(roots[0], 'workspace') });
  const dave = await addUser(accounts, { username: 'dave', password });
  const uid = Number((await admin.query('SELECT GREATEST(COALESCE(MAX(uid)+1,10004),10004) AS uid FROM agent_data.user_runtimes')).rows[0].uid);
  const homes = roots.map(dir => path.join(dir, '.data/users', dave.id, 'codex'));
  await admin.query('INSERT INTO agent_data.user_runtimes(instance_id,user_id,uid,codex_home) VALUES($1,$2,$3,$4)', [scope.instanceId, dave.id, uid, homes[0]]);
  await admin.query(`INSERT INTO agent_data.shard_owners VALUES('0','node-a',17),('1','node-b',23)
    ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch`);
  await admin.query("INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,'0'),($2,'0')", [owner.id, dave.id]);
  const term = String(BigInt((await admin.query('SELECT term FROM agent_data.cluster_term WHERE id=1')).rows[0].term) + 1n);
  const etcd = new FakeClient();
  etcd.set('/codex/slots', JSON.stringify(defaultSlots()));
  for (const [shard, primary, epoch] of [['0','node-a',17], ['1','node-b',23]]) etcd.set('/codex/shards/' + shard, JSON.stringify({ primary, epoch }));
  for (const user of [owner, dave]) etcd.set('/codex/overrides/' + user.id, '"0"');
  const logs = [], isolations = [], members = new Map(), nodes = [];
  const provider = await responsesFixture(root, body => answer(JSON.stringify(body.input).includes('AFTER_MOVE') ? 'continued on node-b' : 'BEFORE_MOVE_REPLY'));
  for (const [index, suffix] of ['a', 'b'].entries()) {
    const nodeId = 'node-' + suffix, cache = await new RouteCache(etcd).open(); cleanup(root, () => cache.close());
    // A test database may contain other logical deployments; membership covers this fixture only.
    const routeOf = cache.routeOf.bind(cache);
    cache.routeOf = userId => [owner.id, dave.id].includes(userId) ? routeOf(userId) : { shardId: null, primary: null, epoch: null, revision: cache.revision };
    const coordination = { nodeId, members, checkLease: () => true, isController: () => index === 0,
      assertController: () => assert.equal(index, 0), confirm: async () => {}, term: () => term,
      guardedPut: async (key, value) => etcd.set(key, JSON.stringify(value)),
      isolate: reason => isolations.push({ nodeId, reason }) };
    const runtime = new ShardRuntime({ nodeId, cache, coordination, key: 'move-uid-test-internal-node-key' });
    const generation = { active: true, nodeId, routes: cache, term, assert() { assert.ok(this.active); },
      log: line => logs.push(line), isolate: reason => { isolations.push({ nodeId, reason }); generation.active = false; } };
    const url = new URL(databaseUrl); url.username = 'agent_node_' + suffix; url.password = password;
    url.searchParams.set('options', '-c app.maintenance=off');
    const config = loadServerConfig(roots[index], { DATABASE_URL: url.href, REDIS_URL: redisUrl,
      CODEX_API_KEY: 'local-fixture', CODEX_BASE_URL: provider.url, CODEX_MODEL: 'local-fixture-model',
      CODEX_MODEL_CATALOG_ENABLED: 'true', CODEX_MODEL_CONTEXT_WINDOW: '128000', DEMO_TIMEOUT_MS: '30000' });
    config.port = 0; config.sharding = runtime;
    const app = await startAgentServer({ config, generation, externalHttp: true, log: line => logs.push(line) });
    cleanup(root, () => app.close()); assert.equal(app.rpc.isolated, true);
    const controlPool = await openDatabase(url.href, { maintenance: false }); cleanup(root, () => controlPool.end());
    const control = new ShardControl(coordination, cache, controlPool); control.log = line => logs.push(line);
    const handler = createShardedHandler(coordination, { app, isReady: () => generation.active }, runtime, control);
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanup(root, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const address = `http://127.0.0.1:${server.address().port}`;
    members.set(nodeId, { nodeId, address }); nodes.push({ app, runtime, generation, address });
  }
  const api = async (index, route, body, expected, token) => {
    const response = await fetch(nodes[index].address + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify({ route, value, logs })); return value;
  };
  const adminToken = (await api(0, '/auth/login', { username: 'admin', password }, 200)).token;
  const token = (await api(1, '/auth/login', { username: 'dave', password }, 200)).token;
  const session = await api(1, '/sessions', {}, 201, token);
  const source = nodes[0].app.runtimes.pool.entries.get(dave.id).value;
  assert.equal(source.runtime.uid, uid); assert.equal(source.runtime.codexHome, homes[0]);
  const proc = fs.readFileSync(`/proc/${source.rpc.child.pid}/status`, 'utf8');
  assert.equal(Number(proc.match(/^Uid:\s+(\d+)/m)[1]), uid);
  assert.ok(!proc.match(/^Groups:\s*(.*)$/m)[1].trim().split(/\s+/).includes('1000'));
  const complete = async (index, id, text) => {
    await api(0, '/messages', { threadId: session.id, clientMessageId: id, text }, 202, token);
    let job;
    await until(async () => {
      job = await runOwner(dave.id, () => nodes[index].app.data.jobs.get(id));
      return ['completed','failed','unconfirmed','interrupted','needs-review'].includes(job?.status);
    }, 60000);
    assert.equal(job.status, 'completed', JSON.stringify({ job, logs }));
  };
  await complete(0, 'before-move', 'BEFORE_MOVE remember the cobalt marker');
  // Seed the exact native scratch shape and 0600-in-0700 case as the real uid.
  const setup = spawnSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path'),h=process.argv[1];
    fs.mkdirSync(p.join(h,'tmp/arg0/migration-fixture'),{recursive:true});
    fs.symlinkSync('/bin/true',p.join(h,'tmp/arg0/migration-fixture/apply_patch'));
    fs.mkdirSync(p.join(h,'migration-private'),{mode:0o700});
    fs.chmodSync(p.join(h,'migration-private'),0o700);
    fs.writeFileSync(p.join(h,'migration-private/history.txt'),'private-cobalt',{mode:0o600});
    fs.chownSync(p.join(h,'migration-private/history.txt'),process.getuid(),process.getgid());`, homes[0]],
    { uid, gid: uid, cwd: '/', env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr || setup.error?.message);
  const relative = path.join('workspace/users', dave.id, 'server-output.txt');
  const workspaceFile = path.join(roots[0], relative);
  fs.writeFileSync(workspaceFile, 'service-owned-cobalt', { mode: 0o660 }); fs.chownSync(workspaceFile, 0, 1000); fs.chmodSync(workspaceFile, 0o660);
  const denied = spawnSync(process.execPath, ['-e', `require('node:fs').readFileSync(process.argv[1])`, workspaceFile], { uid, gid: uid, encoding: 'utf8' });
  assert.notEqual(denied.status, 0); assert.match(denied.stderr, /EACCES/);
  const privateFile = home => path.join(home, 'migration-private/history.txt');
  assert.throws(() => fs.readFileSync(privateFile(homes[0])), { code: 'EACCES' });
  assert.equal(fs.existsSync(homes[1]), false, 'target starts with an independent empty disk');
  const moved = await api(0, '/cluster/move', { username: 'dave', shardId: '1' }, 200, adminToken);
  assert.equal(moved.from, '0'); assert.equal(moved.shardId, '1');
  const stored = (await admin.query('SELECT shard_id,paused FROM agent_data.user_shards WHERE user_id=$1', [dave.id])).rows[0];
  assert.deepEqual(stored, { shard_id: '1', paused: false });
  assert.equal(nodes[0].runtime.cache.overrides[dave.id], '1');
  assert.equal(await nodes[0].runtime.canDispatch(dave.id), false);
  assert.equal(await nodes[1].runtime.canDispatch(dave.id), true);
  assert.equal(nodes[0].app.runtimes.pool.entries.has(dave.id), false);
  assert.ok(source.rpc.child.exitCode !== null || source.rpc.child.signalCode !== null, 'source native process is drained');
  assert.equal(fs.existsSync(path.join(homes[1], 'tmp')), false, 'runtime scratch is not copied');
  const statPrivate = spawnSync(process.execPath, ['-e', `const s=require('node:fs').statSync(process.argv[1]);console.log(JSON.stringify([s.uid,s.gid,s.mode&511]));`, privateFile(homes[1])], { uid, gid: uid, encoding: 'utf8' });
  assert.equal(statPrivate.status, 0, statPrivate.stderr);
  assert.deepEqual(JSON.parse(statPrivate.stdout), [uid, uid, 0o600]);
  assert.equal(fs.statSync(homes[1]).uid, uid);
  assert.equal((await readAsUser(uid, privateFile(homes[1]), { maxBytes: 128 })).toString(), 'private-cobalt');
  const copied = path.join(roots[1], relative), stat = fs.statSync(copied);
  assert.equal(fs.readFileSync(copied, 'utf8'), 'service-owned-cobalt');
  assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777], [0, 1000, 0o660]);
  assert.equal((await api(0, '/sessions/resume', { threadId: session.id }, 200, token)).id, session.id);
  await complete(1, 'after-move', 'AFTER_MOVE continue the same conversation');
  assert.equal(nodes[1].app.runtimes.pool.entries.get(dave.id).value.runtime.codexHome, homes[1]);
  const continuation = provider.requests.find(body => JSON.stringify(body.input).includes('AFTER_MOVE'));
  assert.ok(continuation); assert.match(JSON.stringify(continuation.input), /BEFORE_MOVE_REPLY/);
  assert.equal(nodes[0].app.runtimes.pool.entries.has(dave.id), false, 'forwarding must not restart source runtime');
  assert.equal(await nodes[0].runtime.canDispatch(dave.id), false);
  // Real node-a SQL role + real trigger: bypass the dispatcher to prove the disk copy cannot write.
  await runOwner(dave.id, () => assert.rejects(nodes[0].app.data.pool.query(
    "INSERT INTO agent_data.preferences(instance_id,owner_id,key,value) VALUES($1,$2,'stale-source','forbidden')",
    [scope.instanceId, dave.id]), { code: 'SH001' }));
  assert.equal((await admin.query("SELECT 1 FROM agent_data.preferences WHERE instance_id=$1 AND owner_id=$2 AND key='stale-source'", [scope.instanceId, dave.id])).rowCount, 0);
  assert.deepEqual(isolations, []); assert.deepEqual(provider.errors, []);
  t.diagnostic(`uid=${uid}; node-a → node-b; independent roots; private 0600 + root:1000 0660 preserved; continued; source SH001`);
});
