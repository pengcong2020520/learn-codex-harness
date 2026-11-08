// Real PG node roles, Redis, application services, HTTP forwarding and Codex.
// Only membership/routes and model responses are fixtures; no database or Hub doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { startAgentServer } from '../server/main.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { identity, migrate, openDatabase } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser } from '../server/modules/accounts/admin.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { ShardRuntime } from '../server/modules/sharding/runtime.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
import { cleanup, installToolFixture, tempRoot, until } from './helpers.mjs';
import { answer, responsesFixture } from './responses-fixture.mjs';

const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('设置专用 DATA_TEST_DATABASE_URL 与 DATA_TEST_REDIS_URL。');

test('真实 PG 集群：Hub 快照、HTTP 登录→建会话→消息 completed、跨节点建会话', { timeout: 120000 }, async t => {
  const root = tempRoot(t), roots = ['a', 'b'].map(name => installToolFixture(path.join(root, name)));
  const admin = await openDatabase(databaseUrl, { maintenance: true });
  cleanup(root, () => admin.end());
  await migrate(admin);
  const password = 'sharding-hub-test-password';
  await provisionNodeRoles(admin, { a: password, b: password, c: password },
    (await admin.query('SELECT current_database() AS db')).rows[0].db);
  const scope = identity(roots[0]);
  fs.mkdirSync(path.join(roots[1], '.data'), { recursive: true });
  fs.writeFileSync(path.join(roots[1], '.data/identity.json'), JSON.stringify(scope));
  const store = new AccountStore(admin, scope.instanceId);
  const alice = await initializeAccounts(store, { ownerId: scope.ownerId, username: 'alice', password, workspace: path.join(roots[0], 'workspace') });
  const bob = await addUser(store, { username: 'bob', password });
  // Both paths must work for ordinary users; no administrator/maintenance bypass.
  await store.query("UPDATE agent_data.users SET role='user' WHERE instance_id=$1");
  await admin.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES('0','node-a',17),('1','node-b',23)
    ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch`);
  await admin.query("INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,'0'),($2,'1')", [alice.id, bob.id]);
  const placements = new Map([
    [alice.id, { shardId: '0', primary: 'node-a', epoch: 17 }],
    [bob.id, { shardId: '1', primary: 'node-b', epoch: 23 }],
  ]);
  const provider = await responsesFixture(root, () => answer('集群消息完成。'));
  const members = new Map(), nodes = [];
  for (const [index, suffix] of ['a', 'b'].entries()) {
    const nodeId = 'node-' + suffix;
    const cache = { revision: '1', refresh: async () => {}, routeOf: user =>
      ({ shardId: null, primary: null, epoch: null, ...placements.get(user), revision: '1' }) };
    const coordination = { members, checkLease: () => true };
    const runtime = new ShardRuntime({ nodeId, cache, coordination, key: 'sharding-hub-integration-node-key' });
    const generation = { active: true, nodeId, routes: cache, assert() {
      assert.ok(this.active, 'node generation is active');
    }, isolate: reason => assert.fail('unexpected shard isolation: ' + reason) };
    const url = new URL(databaseUrl);
    url.username = 'agent_node_' + suffix; url.password = password;
    // Override test:data's administrator PGOPTIONS for every application connection.
    url.searchParams.set('options', '-c app.maintenance=off');
    const config = loadServerConfig(roots[index], {
      CODEX_API_KEY: 'local-test-only', CODEX_BASE_URL: provider.url, CODEX_MODEL: 'local-test-model',
      CODEX_MODEL_CATALOG_ENABLED: 'true', CODEX_MODEL_CONTEXT_WINDOW: '128000', DEMO_TIMEOUT_MS: '15000',
      DATABASE_URL: url.href, REDIS_URL: redisUrl,
    });
    config.port = 0; config.sharding = runtime;
    const app = await startAgentServer({ config, generation, externalHttp: true, log: () => {} });
    cleanup(root, () => app.close());
    const handler = createShardedHandler(coordination, { app, isReady: () => generation.active }, runtime, {});
    const server = createServer((req, res) => { void handler(req, res).catch(error => res.destroy(error)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanup(root, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const address = `http://127.0.0.1:${server.address().port}`;
    members.set(nodeId, { nodeId, address }); nodes.push({ app, address });
  }

  await t.test('snapshot 在带 node/epoch 的真实只读 REPEATABLE READ 事务内执行', async () => {
    for (const [index, user] of [alice, bob].entries()) {
      const hub = nodes[index].app.permissionHub, original = hub.user;
      const observer = t.mock.method(hub, 'user', async function(id, client, allowDisabled) {
        const { rows: [settings] } = await client.query(`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS read_only, current_setting('app.node') AS node,
          current_setting('app.shard_epoch') AS epoch, current_setting('app.maintenance') AS maintenance,
          current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
        assert.deepEqual(settings, { isolation: 'repeatable read', read_only: 'on',
          node: index ? 'node-b' : 'node-a', epoch: index ? '23' : '17', maintenance: 'off',
          role: index ? 'agent_node_b' : 'agent_node_a', superuser: false });
        return original.call(this, id, client, allowDisabled);
      });
      try {
        const snapshot = await runOwner(user.id, () => hub.snapshot(user.id));
        assert.equal(snapshot.user.id, user.id); assert.equal(snapshot.user.role, 'user');
        assert.equal(observer.mock.callCount(), 1);
      } finally { observer.mock.restore(); }
    }
  });

  const api = async (node, route, body, status, token) => {
    const response = await fetch(nodes[node].address + route, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`); return value;
  };
  const flow = async (user, owner, messageId) => {
    // Login and every subsequent request enter node-a; Bob must be forwarded to node-b.
    const login = await api(0, '/auth/login', { username: user.username, password }, 200);
    assert.equal(login.user.id, user.id); assert.equal(login.user.role, 'user');
    const session = await api(0, '/sessions', {}, 201, login.token);
    assert.ok(nodes[owner].app.sessions.sessions.has(session.id), 'owner node must create the session');
    assert.equal(nodes[1 - owner].app.sessions.sessions.has(session.id), false, 'other node must not create the session');
    const { rows: [conversation] } = await admin.query('SELECT owner_id FROM agent_data.conversations WHERE instance_id=$1 AND id=$2', [scope.instanceId, session.id]);
    assert.equal(conversation.owner_id, user.id);
    await api(0, '/messages', { threadId: session.id, clientMessageId: messageId, text: '请回复集群消息完成' }, 202, login.token);
    let task;
    await until(async () => {
      task = (await admin.query('SELECT status,error,turn_id FROM agent_data.tasks WHERE instance_id=$1 AND id=$2', [scope.instanceId, messageId])).rows[0];
      return task && ['completed', 'failed', 'needs-review', 'unconfirmed', 'interrupted'].includes(task.status);
    }, 30000);
    assert.equal(task.status, 'completed', JSON.stringify(task)); assert.ok(task.turn_id);
    await nodes[owner].app.usage.pending;
  };
  await t.test('本节点 HTTP 登录→创建会话→模拟模型→completed', () => flow(alice, 0, 'cluster-local'));
  await t.test('两个节点共用 PG：node-a 登录→转发 node-b 建会话→completed', () => flow(bob, 1, 'cluster-forwarded'));
  assert.ok(provider.requests.length >= 2, 'both turns must reach the simulated model');
  assert.deepEqual(provider.errors, []);
});
