import { nodeAuth, authHeaders } from './fixtures/node-auth.mjs';
// Real PG node roles, Redis, application services, HTTP forwarding and Codex.
// Only membership/routes and model responses are fixtures; no database or Hub doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import pg from 'pg';
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
import { answer, responsesFixture, toolCall, toolSpecs } from './responses-fixture.mjs';

const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('设置专用 DATA_TEST_DATABASE_URL 与 DATA_TEST_REDIS_URL。');

test('真实 PG 双节点：general 导入→维护 completed/wiki-effective→跨分片授权读取→拒绝写入→撤销，零隔离', { timeout: 120000 }, async t => {
  const root = tempRoot(t), roots = ['c', 'a'].map(name => installToolFixture(path.join(root, name), { knowledge: true }));
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
  const dave = await addUser(store, { username: 'dave', password });
  const carol = await addUser(store, { username: 'carol', password });
  await admin.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES('2','node-c',23),('0','node-a',17)
    ON CONFLICT(shard_id) DO UPDATE SET replica=NULL,replica_ready=false,node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch`);
  await admin.query("INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,'2'),($2,'0'),($3,'0'),($4,'2')", [alice.id, bob.id, dave.id, carol.id]);
  const placements = new Map([
    [alice.id, { shardId: '2', primary: 'node-c', epoch: 23 }],
    [carol.id, { shardId: '2', primary: 'node-c', epoch: 23 }],
    [bob.id, { shardId: '0', primary: 'node-a', epoch: 17 }],
    [dave.id, { shardId: '0', primary: 'node-a', epoch: 17 }],
  ]);
  const content = '# Tea\n茶叶保存：密封、避光、干燥。', kbId = 'general', slug = 'tea';
  let step = 0;
  const provider = await responsesFixture(root, body => {
    const call = (name, args) => toolCall(toolSpecs(body).find(tool => tool.name === name), args);
    const outputs = (body.input || []).filter(item => item.type === 'function_call_output').map(item =>
      JSON.parse(typeof item.output === 'string' ? item.output : item.output[0].text));
    if (step++ === 0) return call('read_file', { path: 'inputs/general/tea.md' });
    if (step === 2) {
      const source = outputs.at(-1); assert.ok(source.resourceId && source.versionId);
      return call('kb_submit_revision', { kbId, slug, content, expectedVersion: null,
        source_versions: [{ resourceId: source.resourceId, versionId: source.versionId }] });
    }
    assert.equal(outputs.at(-1).effective, true); return answer('Wiki 已生成。');
  });
  const logs = [], isolations = [];
  const members = new Map(), nodes = [];
  for (const [index, suffix] of ['c', 'a'].entries()) {
    const nodeId = 'node-' + suffix;
    const cache = { revision: '1', refresh: async () => {}, routeOf: user =>
      ({ shardId: null, primary: null, epoch: null, ...placements.get(user), revision: '1' }) };
    const coordination = { members, checkLease: () => true };
    const runtime = new ShardRuntime({ nodeId, cache, coordination, ...nodeAuth(nodeId) });
    const generation = { active: true, nodeId, routes: cache, assert() {
      assert.ok(this.active, 'node generation is active');
    }, log: line => logs.push(line), isolate: reason => { isolations.push({ nodeId, reason }); generation.active = false; } };
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
    const app = await startAgentServer({ config, generation, externalHttp: true, log: line => logs.push(line) });
    cleanup(root, () => app.close());
    const handler = createShardedHandler(coordination, { app, isReady: () => generation.active }, runtime, {});
    const server = createServer((req, res) => { void handler(req, res).catch(error => res.destroy(error)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanup(root, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const address = `http://127.0.0.1:${server.address().port}`;
    members.set(nodeId, { nodeId, address }); nodes.push({ app, address, generation });
  }

  const api = async (node, route, body, status, token, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(nodes[node].address + route, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify({ value, logs, isolations })}`); return value;
  };
  const tokens = {};
  for (const user of [alice, bob, dave]) tokens[user.username] = (await api(1, '/auth/login', { username: user.username, password }, 200)).token;
  // Every owner mutation enters node-a and must execute on node-c; roots and blobs are independent.
  const imported = await api(1, '/knowledge/source', { kbId, name: 'tea.md', content }, 201, tokens.alice);
  assert.ok(imported.resourceId && imported.versionId);
  const source = path.join('workspace/users', alice.id, 'inputs/general/tea.md');
  assert.equal(fs.readFileSync(path.join(roots[0], source), 'utf8'), content);
  assert.equal(fs.existsSync(path.join(roots[1], source)), false);
  const session = await api(1, '/sessions', {}, 201, tokens.alice);
  await api(1, '/messages', { threadId: session.id, clientMessageId: 'cluster-maintain', text: '维护知识库',
    workflow: 'knowledge-maintain', params: { kbId } }, 202, tokens.alice);
  let job;
  await until(async () => {
    job = await runOwner(alice.id, () => nodes[0].app.data.jobs.get('cluster-maintain'));
    return ['completed', 'needs-review', 'failed', 'unconfirmed', 'interrupted'].includes(job?.status);
  }, 60000);
  assert.equal(job.status, 'completed', JSON.stringify({ job, logs }));
  assert.deepEqual(job.checks.map(check => [check.id, check.passed]), [['wiki-effective', true]]);
  await api(1, '/hub/knowledge/general/grants', { username: 'bob' }, 200, tokens.alice);
  const foreignWrites = [], query = pg.Client.prototype.query;
  t.mock.method(pg.Client.prototype, 'query', function (...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
    if (this.user === 'agent_node_a' && /\b(INSERT|UPDATE|DELETE)\b/i.test(sql) &&
        /agent_data\.(resources|resource_versions|dependencies|wiki_pages|wiki_versions|knowledge_bases|knowledge_mounts|knowledge_jobs|knowledge_indexes)\b/.test(sql)) foreignWrites.push(sql);
    return query.apply(this, args);
  });
  for (const entry of [0, 1]) {
    const search = await api(entry, '/knowledge/search', { kbId, query: '茶叶' }, 200, tokens.bob);
    assert.equal(search.hits[0].content, content);
    const page = await api(entry, `/knowledge/read?kbId=${kbId}&slug=${slug}`, undefined, 200, tokens.bob);
    assert.equal(page.content, content);
    await api(entry, '/knowledge/search', { kbId, query: '茶叶' }, 404, tokens.dave);
    await api(entry, `/knowledge/read?kbId=${kbId}&slug=${slug}`, undefined, 404, tokens.dave);
    await api(entry, '/knowledge/source', { kbId, name: 'forbidden.md', content }, 403, tokens.bob);
  }
  await api(1, '/hub/knowledge/general/grants/bob', undefined, 200, tokens.alice, 'DELETE');
  await api(1, '/knowledge/search', { kbId, query: '茶叶' }, 404, tokens.bob);
  await api(1, `/knowledge/read?kbId=${kbId}&slug=${slug}`, undefined, 404, tokens.bob);
  for (const { app, generation } of nodes) { await app.usage.pending; assert.equal(generation.active, true); }
  assert.deepEqual(foreignWrites, [], 'node-a reads must not write owner knowledge rows');
  assert.deepEqual(isolations, []);
  assert.equal(logs.some(line => /\[(SH001|CT001)\]/.test(line)), false, 'no hidden fence failure may be swallowed');
  assert.equal(nodes[1].app.runtimes.pool.entries.has(bob.id), false, 'read-only HTTP does not start a grantee runtime');
  assert.equal(nodes[1].app.runtimes.pool.entries.has(dave.id), false);
  const { rows: [stored] } = await admin.query('SELECT blob FROM agent_data.wiki_versions WHERE instance_id=$1 AND kb_id=$2 AND slug=$3', [scope.instanceId, kbId, slug]);
  assert.ok(fs.existsSync(path.join(roots[0], '.data/files/objects', stored.blob)));
  assert.equal(fs.existsSync(path.join(roots[1], '.data/files/objects', stored.blob)), false);
  assert.deepEqual(provider.errors, []);
  assert.equal(fs.existsSync(path.join(roots[1], source)), false);
});
