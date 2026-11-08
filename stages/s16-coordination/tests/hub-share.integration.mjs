// Real PG/Redis/Codex + HTTP; only model responses (and optional embeddings) are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { startAgentServer } from '../server/main.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { openDatabase, migrate, identity } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser } from '../server/modules/accounts/admin.mjs';
import { currentIdentity } from '../server/modules/accounts/context.mjs';
import { asUser, installToolFixture, tempRoot, cleanup, until } from './helpers.mjs';
import { responsesFixture, answer, toolCall, toolSpecs } from './responses-fixture.mjs';

const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('设置专用 DATA_TEST_DATABASE_URL 与 DATA_TEST_REDIS_URL。');
const kbId = 'bob-library', slug = 'services', content = '# Bob 的服务\n海蓝门店有三种服务：配送、提货、咨询。';
const terminal = ['completed', 'needs-review', 'failed', 'unconfirmed', 'interrupted'];

test('真实 PG 共享知识库：所有者原文/Wiki/检索、只读授权、撤权后的会话门禁与审计', { timeout: 120000 }, async t => {
  const root = installToolFixture(tempRoot(t), { knowledge: true });
  fs.mkdirSync(path.join(root, 'workspace/inputs/general'), { recursive: true });
  const pool = await openDatabase(databaseUrl); cleanup(root, () => pool.end()); await migrate(pool);
  const scope = identity(root), store = new AccountStore(pool, scope.instanceId);
  const users = { bob: await initializeAccounts(store, { ownerId: scope.ownerId, username: 'bob', password: 'fixture-password', workspace: path.join(root, 'workspace') }) };
  for (const username of ['carol', 'dave']) users[username] = await addUser(store, { username, password: 'fixture-password' });
  // Bob exercises owner privileges, not the admin bypass. All three callers use basic/user.
  await store.query("UPDATE agent_data.users SET role='user' WHERE instance_id=$1 AND id=$2", [users.bob.id]);

  let refs, maintainStep = 0, readStep = 0;
  const provider = await responsesFixture(root, body => {
    const specs = toolSpecs(body), call = (name, args) => {
      const spec = specs.find(item => item.name === name); assert.ok(spec, `missing tool: ${name}`);
      return toolCall(spec, args);
    };
    const outputs = (body.input || []).filter(item => item.type === 'function_call_output').map(item =>
      JSON.parse(typeof item.output === 'string' ? item.output : item.output[0].text));
    if (JSON.stringify(body.input).includes('SHARED_READ')) {
      if (readStep++ === 0) return call('kb_read', { kbId, slug });
      if (readStep === 2) {
        assert.equal(outputs.at(-1).content, content, 'Carol 的动态工具必须读到 Bob 的 Wiki');
        return call('kb_search', { kbId, query: '海蓝', limit: 5 });
      }
      assert.ok(outputs.at(-1).hits.some(hit => hit.content.includes('海蓝')));
      return answer('共享知识库读取与检索完成。');
    }
    if (maintainStep++ === 0) return call('read_file', { path: `inputs/${kbId}/source.md` });
    if (maintainStep === 2) {
      const source = outputs.at(-1); assert.ok(source.resourceId && source.versionId);
      refs = [{ resourceId: source.resourceId, versionId: source.versionId }];
      return call('kb_submit_revision', { kbId, slug, content, expectedVersion: null, source_versions: refs });
    }
    assert.equal(outputs.at(-1).effective, true);
    return answer('Bob 的 Wiki 已生成。');
  });

  let embeddingUrl;
  if (process.env.CHROMA_TEST_URL) {
    const server = createServer(async (req, res) => {
      const blocks = []; for await (const block of req) blocks.push(block);
      const body = JSON.parse(Buffer.concat(blocks));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup(root, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    embeddingUrl = `http://127.0.0.1:${server.address().port}`;
    const file = path.join(root, 'agents/writing/agent.json'), definition = JSON.parse(fs.readFileSync(file));
    definition.agent.knowledge[0].mode = 'rag'; fs.writeFileSync(file, JSON.stringify(definition));
  }
  const config = loadServerConfig(root, {
    CODEX_API_KEY: 'local-test-only', CODEX_BASE_URL: provider.url, CODEX_MODEL: 'local-test-model',
    CODEX_MODEL_CATALOG_ENABLED: 'true', CODEX_MODEL_CONTEXT_WINDOW: '128000', DEMO_TIMEOUT_MS: '15000',
    DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
    ...(embeddingUrl ? { CHROMA_URL: process.env.CHROMA_TEST_URL, EMBEDDING_BASE_URL: embeddingUrl, EMBEDDING_MODEL: 'fixture-3d', EMBEDDING_DIMENSIONS: '3' } : {}),
  }); config.port = 0;
  let app = await startAgentServer({ config, log: () => {} }); cleanup(root, () => app.close());
  const tokens = {};
  for (const name of Object.keys(users)) {
    const response = await fetch(app.url + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'fixture-password' }) });
    assert.equal(response.status, 200);
    const login = await response.json(); assert.equal(login.user.role, 'user'); tokens[name] = login.token;
  }
  const api = async (name, route, body, status = 200, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.url + route, { method, headers: { authorization: `Bearer ${tokens[name]}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const as = (name, operation) => asUser(app.permissionHub, users[name].id, operation);
  const job = (name, id) => as(name, () => app.messages.job(id));
  const settled = async (name, id) => {
    await until(async () => terminal.includes((await job(name, id))?.status), 30000);
    return job(name, id);
  };
  // The HTTP endpoint initializes Bob's runtime and creates a private KB as an ordinary user.
  const created = await api('bob', '/knowledge', { kbId, title: 'Bob 自建资料库' }, 201);
  assert.equal(created.ownerId, users.bob.id); assert.equal(created.visibility, 'private');
  assert.equal(created.sourceRoot, `inputs/${kbId}`);
  await api('carol', '/knowledge', { kbId, title: '重复 ID' }, 409);
  // Real PostgreSQL advisory-lock/count race: general + bob-library leave only one basic slot.
  const raced = await Promise.all(['slot-a', 'slot-b', 'slot-c'].map(async id => {
    const response = await fetch(app.url + '/knowledge', { method: 'POST', headers: { authorization: `Bearer ${tokens.bob}`, 'content-type': 'application/json' }, body: JSON.stringify({ kbId: id, title: id }) });
    return { id, status: response.status, body: await response.json() };
  }));
  assert.equal(raced.filter(r => r.status === 201).length, 1, JSON.stringify(raced));
  assert.ok(raced.filter(r => r.status !== 201).every(r => r.status === 403 && r.body.error.code === 'PLAN_LIMIT'), JSON.stringify(raced));
  await api('bob', '/knowledge/' + raced.find(r => r.status === 201).id, undefined, 200, 'DELETE');
  const bobSession = await api('bob', '/sessions', {}, 201);
  const imported = await api('bob', '/knowledge/source', { kbId, name: 'source.md', content }, 201);
  const kb = (await pool.query('SELECT owner_id FROM agent_data.knowledge_bases WHERE instance_id=$1 AND id=$2', [scope.instanceId, kbId])).rows[0];
  assert.equal(kb.owner_id, users.bob.id);
  await api('bob', '/messages', { threadId: bobSession.id, clientMessageId: 'share-maintain', text: '维护知识库', workflow: 'knowledge-maintain', params: { kbId } }, 202);
  const maintained = await settled('bob', 'share-maintain');
  assert.equal(maintained.status, 'completed', JSON.stringify(maintained));
  assert.deepEqual(maintained.checks.map(check => [check.id, check.passed]), [['wiki-effective', true]]);
  assert.equal(refs[0].resourceId, imported.resourceId);
  const bobPage = await api('bob', `/knowledge/read?kbId=${kbId}&slug=${slug}`);
  assert.equal(bobPage.content, content);

  if (embeddingUrl) {
    const queued = await api('bob', '/knowledge/index', { kbId }, 202);
    let indexed;
    await until(async () => {
      indexed = await as('bob', () => app.gate.run(app.gate.user(), () => app.knowledge.job(queued.jobId)));
      return ['completed', 'failed'].includes(indexed.state);
    }, 30000);
    assert.equal(indexed.state, 'completed', JSON.stringify(indexed));
    // Effective retrieval mode is pinned at startup; restart as the existing RAG fixture does.
    await app.close(); app = await startAgentServer({ config, log: () => {} });
  }
  await api('bob', `/hub/knowledge/${kbId}/grants`, { username: 'carol' });
  assert.equal((await api('carol', '/knowledge')).knowledge.find(item => item.kbId === kbId).visibility, 'shared');
  const carolSession = await api('carol', '/sessions', {}, 201);
  const mount = (await pool.query('SELECT owner_id,hub_knowledge FROM agent_data.conversations WHERE instance_id=$1 AND id=$2', [scope.instanceId, carolSession.id])).rows[0];
  assert.equal(mount.owner_id, users.carol.id); assert.ok(mount.hub_knowledge.includes(kbId));

  const bobRoot = path.join(root, 'workspace/users', users.bob.id), carolRoot = path.join(root, 'workspace/users', users.carol.id);
  fs.mkdirSync(path.join(carolRoot, `inputs/${kbId}`), { recursive: true });
  fs.writeFileSync(path.join(carolRoot, `inputs/${kbId}/source.md`), '# Carol 的同名资料\n不属于 Bob 的知识库。');
  // Observe successful real fs opens, without replacing the read or its returned content.
  const actualReads = [], openSync = fs.openSync;
  const observer = t.mock.method(fs, 'openSync', function(file, ...args) {
    const fd = Reflect.apply(openSync, fs, [file, ...args]);
    if (currentIdentity()?.userId === users.carol.id && typeof file === 'string' && file.startsWith(path.join(root, 'workspace/users') + path.sep)) actualReads.push(path.resolve(file));
    return fd;
  });
  try {
    const carolPage = await api('carol', `/knowledge/read?kbId=${kbId}&slug=${slug}`);
    assert.deepEqual(carolPage, bobPage);
    const result = await api('carol', '/knowledge/search', { kbId, query: '海蓝', limit: 5 });
    assert.equal(result.mode, embeddingUrl ? 'rag' : 'wiki');
    assert.ok(result.hits.some(hit => hit.content.includes('海蓝')));
    if (embeddingUrl) assert.ok(result.hits.every(hit => hit.resourceId === imported.resourceId));
    else assert.ok(result.hits.every(hit => hit.kbId === kbId && hit.versionId === bobPage.versionId));
    assert.ok(actualReads.includes(path.join(bobRoot, `inputs/${kbId}/source.md`)), '必须实际打开 Bob 的原文，不能只核对拼接结果');
    assert.ok(actualReads.every(file => path.isAbsolute(file) && file.startsWith(bobRoot + path.sep)), JSON.stringify(actualReads));
  } finally { observer.mock.restore(); }

  await api('carol', '/messages', { threadId: carolSession.id, clientMessageId: 'shared-read', text: 'SHARED_READ 读取并检索共享知识库' }, 202);
  const read = await settled('carol', 'shared-read'); assert.equal(read.status, 'completed', JSON.stringify(read));
  assert.equal(readStep, 3);
  await assert.rejects(as('carol', () => app.gate.run(app.gate.user(), () => app.knowledge.submit({ kbId, slug, content: '# 非法更新', expectedVersion: bobPage.versionId, source_versions: refs }))), error => error.status === 403);
  await api('carol', '/knowledge/source', { kbId, name: 'unauthorized.md', content: '# 非法原文' }, 403);
  await api('carol', '/knowledge/index', { kbId }, 403);
  await api('carol', `/hub/knowledge/${kbId}/grants`, { username: 'dave' }, 403);
  assert.deepEqual(await api('bob', `/knowledge/read?kbId=${kbId}&slug=${slug}`), bobPage);

  assert.ok(!(await api('dave', '/knowledge')).knowledge.some(item => item.kbId === kbId));
  assert.ok(!(await api('dave', '/hub')).resources.some(item => item.type === 'knowledge' && item.id === kbId));
  await api('dave', `/knowledge/read?kbId=${kbId}&slug=${slug}`, undefined, 404);
  await api('dave', '/knowledge/search', { kbId, query: '海蓝' }, 404);
  await api('dave', '/resources/read?id=' + imported.resourceId, undefined, 404);

  await api('bob', `/hub/knowledge/${kbId}/grants/carol`, undefined, 200, 'DELETE');
  await api('carol', `/knowledge/read?kbId=${kbId}&slug=${slug}`, undefined, 404);
  await api('carol', '/resources/read?id=' + imported.resourceId, undefined, 404);
  assert.ok(!(await api('carol', '/knowledge')).knowledge.some(item => item.kbId === kbId));
  const requestsBefore = provider.requests.length;
  await api('carol', '/messages', { threadId: carolSession.id, clientMessageId: 'after-revoke', text: '再次读取共享知识库' }, 202);
  const rejected = await settled('carol', 'after-revoke');
  assert.equal(rejected.status, 'failed', JSON.stringify(rejected));
  assert.match(rejected.error, /资源不存在|未授权/);
  assert.equal(rejected.turnId, null, '撤权必须在下一轮启动前拒绝任务');
  assert.equal(provider.requests.length, requestsBefore, '被拒任务不能到达模型');
  assert.deepEqual(provider.errors, []);
  assert.throws(() => app.permissionHub.current(), /Hub 缺少可信权限快照/);

  const events = (await pool.query('SELECT actor_id,action,before_state,after_state FROM agent_data.permission_events WHERE instance_id=$1 AND resource_type=$2 AND resource_id=$3 ORDER BY id', [scope.instanceId, 'knowledge', kbId])).rows;
  // Public grant/revoke operations are named share/unshare in the append-only audit schema.
  assert.equal(events[0].action, 'knowledge:create');
  assert.equal(events[0].actor_id, users.bob.id);
  assert.equal(events[0].after_state.title, 'Bob 自建资料库');
  assert.deepEqual(events.slice(1), [
    { actor_id: users.bob.id, action: 'share', before_state: [], after_state: [users.carol.id] },
    { actor_id: users.bob.id, action: 'unshare', before_state: [users.carol.id], after_state: [] },
  ]);
  // Deletion revokes remaining grants, removes Wiki/index registry rows and owner directories.
  await api('bob', `/hub/knowledge/${kbId}/grants`, { username: 'carol' });
  await api('bob', `/knowledge/${kbId}`, undefined, 200, 'DELETE');
  await api('carol', `/knowledge/read?kbId=${kbId}&slug=${slug}`, undefined, 404);
  assert.equal(fs.existsSync(path.join(bobRoot, `inputs/${kbId}`)), false);
  assert.equal(fs.existsSync(path.join(bobRoot, `research/${kbId}/wiki`)), false);
  assert.equal((await pool.query('SELECT 1 FROM agent_data.resource_grants WHERE instance_id=$1 AND resource_id=$2', [scope.instanceId, kbId])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM agent_data.knowledge_indexes WHERE instance_id=$1 AND kb_id=$2', [scope.instanceId, kbId])).rowCount, 0);
  await api('bob', '/knowledge', { kbId, title: '重新创建' }, 201);
  const replacement = await api('bob', '/knowledge/source', { kbId, name: 'source.md', content: '# 新资料' }, 201);
  assert.notEqual(replacement.versionId, imported.versionId);
  await api('carol', '/resources/read?id=' + replacement.resourceId, undefined, 404);
  await api('bob', `/knowledge/${kbId}`, undefined, 200, 'DELETE');
  t.diagnostic(`PASS: Carol reads Bob's actual source path; ${embeddingUrl ? 'Chroma RAG' : 'Wiki search'}; 403 writes, 404 hidden/revoked reads; next turn rejected; grant/revoke audit.`);
});
