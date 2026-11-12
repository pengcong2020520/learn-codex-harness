import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AsyncResource } from 'node:async_hooks';
import { RuntimePool } from '../server/modules/runtimes/pool.mjs';
import { RuntimeRouter } from '../server/modules/runtimes/router.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { ExecutionBoundary } from '../server/modules/agents/boundary.mjs';
import { FakeRpc, until } from './helpers.mjs';
import { hubFixture } from './hub-fixture.mjs';
import { Resources } from '../server/modules/data/resources.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { KnowledgeService } from '../server/modules/knowledge/index.mjs';
import { knowledgeBinding, prepareKnowledgeDirectories } from '../server/modules/knowledge/directories.mjs';
import { effectiveKnowledgeMounts } from '../server/modules/knowledge/mounts.mjs';
import { currentIdentity, runOwner } from '../server/modules/accounts/context.mjs';
import { defineWorkflows } from '../server/modules/workflows/index.mjs';
import { MessageService } from '../server/modules/messages/index.mjs';
import { TestJobs } from './jobs-fixture.mjs';

function fixture(t) {
  const f = hubFixture();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-kb-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const owner of ['alice','bob','carol','dave']) fs.mkdirSync(path.join(root, 'workspace/users', owner), { recursive: true });
  const scope = { instanceId: 'test', get ownerId() { return currentIdentity().userId; } };
  const agent = { definition: { agent: { ...f.agent, skills: [], workflows: [{ id: 'knowledge-maintain' }] }, bindings: {} },
    assertCurrent() {}, sources: [{ locator: 'inputs', actions: ['read'] }, { locator: 'research', actions: ['read','create'] }], outputs: { directory: 'outputs' } };
  const gate = new PermissionGate({ scope, agent, permissionHub: f.hub });
  const files = { get workspace() { return path.join(root, 'workspace/users', currentIdentity().userId); } };
  const resources = { files, async registerImported() { return { resourceId: 'source', versionId: 'version' }; } };
  const service = new KnowledgeService(f.pool, scope, { agent, gate, resources }); service.modes = {};
  service.query = async (sql, args) => {
    if (sql.startsWith('SELECT uid')) return { rows: [{ uid: process.getuid() }] };
    if (sql.startsWith('SELECT * FROM agent_data.knowledge_bases')) return { rows: f.state.knowledge.filter(r => r.id === args[0]) };
    throw new Error(sql);
  };
  const as = (owner, fn) => f.as(owner, () => gate.run(gate.user(), fn));
  const create = (id, owner = 'bob') => as(owner, () => service.create({ kbId: id, title: `Title ${id}` }));
  return { ...f, root, service, agent, gate, as, create };
}

test('用户创建：所有者目录/private/title/审计；ID 冲突、basic 第四个、admin 不限与输入校验', async t => {
  const f = fixture(t);
  const result = await f.create('new-kb');
  assert.equal(result.ownerId, 'bob'); assert.equal(result.visibility, 'private');
  assert.equal(f.state.knowledge.find(r => r.id === 'new-kb').title, 'Title new-kb');
  for (const relative of ['inputs/new-kb','research/new-kb/wiki']) {
    assert.ok(fs.statSync(path.join(f.root, 'workspace/users/bob', relative)).isDirectory());
    assert.equal(fs.existsSync(path.join(f.root, 'workspace/users/alice', relative)), false);
  }
  assert.equal(f.state.events.at(-1).action, 'knowledge:create');
  await assert.rejects(f.create('new-kb', 'carol'), e => e.status === 409);
  await f.create('third');
  await assert.rejects(f.create('fourth'), e => e.status === 403 && e.code === 'PLAN_LIMIT');
  assert.equal(fs.existsSync(path.join(f.root, 'workspace/users/bob/inputs/fourth')), false);
  for (let i = 0; i < 22; i++) await f.create(`admin-${i}`, 'alice');
  await f.create('9' + 'a'.repeat(63), 'alice');
  for (const id of ['', 'A', '../escape', 'a'.repeat(65)])
    await assert.rejects(f.create(id), e => e.status === 400);
});

test('并发创建在事务锁后计数；basic 不超额，pro 限额 20', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => f.create(`parallel-${i}`)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'PLAN_LIMIT'));
  assert.equal(f.state.knowledge.filter(r => r.owner_id === 'bob').length, 3);
  await f.as('alice', () => f.hub.assign('bob', 'pro'));
  const pro = await Promise.allSettled(Array.from({ length: 19 }, (_, i) => f.create(`pro-${i}`)));
  assert.equal(pro.filter(r => r.status === 'fulfilled').length, 17);
});

test('自建库继承默认动作并与 Hub 相交；workflow 才能更新，共享人只读、未授权 404', async t => {
  const f = fixture(t); await f.create('mine');
  await f.as('bob', async () => {
    // Narrow static dataBindings must not make an otherwise valid dynamic mount unusable.
    f.agent.sources = [{ locator: 'inputs/general', actions: ['read'] }];
    const reader = Object.assign(Object.create(Resources.prototype), { scope: f.gate.scope,
      sources: f.agent.sources, outputs: f.agent.outputs, gate: f.gate, files: f.service.resources.files });
    await f.service.importSource({ kbId: 'mine', name: 'source.md', content: '# mine' });
    assert.equal(reader.source('inputs/mine/source.md', 'read'), 'knowledge:mine');
    assert.equal(reader.sourceFiles('inputs/mine/source.md').read_file({ path: 'inputs/mine/source.md' }).content, '# mine');
    assert.ok((await f.service.list()).some(m => m.kbId === 'mine'));
    f.gate.check('read', { path: 'inputs/mine/source.md' });
    assert.throws(() => f.gate.check('create', { path: 'inputs/mine/new.md' }), /未授权/);
    assert.throws(() => f.gate.check('create', { path: 'research/mine/wiki/fake.md' }), /未授权/);
    const workflows = defineWorkflows(f.agent.definition.agent);
    const wf = workflows.resolve('knowledge-maintain', { kbId: 'mine' }, id => effectiveKnowledgeMounts(f.agent, f.hub).some(m => m.kbId === id && m.actions.includes('update')));
    f.gate.start({ userId: 'bob', threadId: 'chat' }); f.gate.started('chat', 'turn');
    await assert.rejects(f.gate.run(f.gate.forTurn('chat','turn'), () => f.gate.check('update', { kbId: 'mine' })), e => e.status === 403);
    f.gate.end('chat');
    f.gate.start({ userId: 'bob', threadId: 'maintain' }, wf.grants); f.gate.started('maintain', 'turn');
    await f.gate.run(f.gate.forTurn('maintain','turn'), () => f.gate.check('update', { kbId: 'mine' })); f.gate.end('maintain');
    await f.hub.grantKnowledge('mine', 'carol');
  });
  await f.as('carol', async () => {
    assert.deepEqual((await f.service.list()).find(m => m.kbId === 'mine').actions, ['read']);
    await f.service.kb('mine');
    await assert.rejects(f.service.kb('mine', 'update'), e => e.status === 403);
  });
  await assert.rejects(f.as('dave', () => f.service.kb('mine')), e => e.status === 404);
  f.agent.definition.agent.knowledge = [];
  await assert.rejects(f.as('bob', () => f.service.kb('mine')), e => e.status === 403);
});

test('维护验收：完成通知和提前结束绑定均按任务 owner 恢复 Hub；自建库与静态库执行相同检查', async t => {
  const f = fixture(t); await f.create('mine');
  f.agent.workflows = defineWorkflows(f.agent.definition.agent);
  const store = new TestJobs(), sessions = new EventEmitter();
  const messages = new MessageService({ rpc: new EventEmitter(), sessions, store,
    config: { agent: f.agent }, permissionHub: f.hub });
  messages.publish = async () => {};
  messages.wake = async () => {};
  for (const entry of ['completed', 'bind']) for (const kbId of ['general', 'mine']) for (const effective of [true, false]) {
    const id = `${entry}-${kbId}-${effective}`, turn = { id: `turn-${id}`, status: 'completed',
      revisions: effective ? { revision: { kbId, slug: 'page', effective: true } } : {} };
    store.create({ id, threadId: id, userId: 'bob', mode: 'enqueue', workflow: 'knowledge-maintain', params: { kbId } });
    store.patch(id, { status: entry === 'bind' ? 'starting' : 'running', turnId: turn.id });
    sessions.getTurn = () => turn;
    const finish = () => entry === 'bind' ? messages.bind(id, turn.id) : messages.completed(id, turn);
    // 完成通知没有 Hub 上下文；提前完成时即使调用者是其他用户，也必须使用任务 owner。
    if (entry === 'completed') await finish();
    else await f.as('carol', finish);
    assert.equal(store.get(id).status, effective ? 'completed' : 'needs-review', id);
    assert.deepEqual(store.get(id).checks.map(check => [check.id, check.passed]), [['wiki-effective', effective]], id);
    assert.equal(store.get(id).error, null);
    assert.throws(() => f.hub.current(), /Hub 缺少可信权限快照/);
  }
  const denied = await messages.outcome({ userId: 'carol', workflow: 'knowledge-maintain', params: { kbId: 'mine' } },
    { status: 'completed', revisions: { revision: { kbId: 'mine', slug: 'page', effective: true } } });
  assert.equal(denied.status, 'needs-review', '不能借验收给无权用户放行');
  assert.match(denied.error, /Workflow 验收未完成/);
});

test('删除：执行中/索引中 409；所有者或 admin 清理授权、目录、索引、源记录及审计', async t => {
  const f = fixture(t); await f.create('remove');
  await f.as('bob', () => f.service.importSource({ kbId: 'remove', name: 'a.md', content: '# source' }));
  await f.as('bob', () => f.hub.grantKnowledge('remove', 'carol'));
  await assert.rejects(f.as('carol', () => f.service.delete('remove')), e => e.status === 403);
  await assert.rejects(f.as('dave', () => f.service.delete('remove')), e => e.status === 404);
  f.state.active.push({ kbId: 'remove' });
  await assert.rejects(f.as('bob', () => f.service.delete('remove')), e => e.status === 409);
  f.state.active = [];
  await f.as('bob', () => f.gate.start({ userId: 'bob', threadId: 'running' }));
  await assert.rejects(f.as('bob', () => f.service.delete('remove')), e => e.status === 409);
  f.gate.end('running');
  f.state.jobs.push({ kb_id: 'remove', state: 'running' });
  await assert.rejects(f.as('bob', () => f.service.delete('remove')), e => e.status === 409);
  f.state.jobs = [];
  const discarded = [];
  f.service.rag = { async discard(m) { discarded.push(m); } };
  f.service.modes.remove = 'rag';
  f.state.indexes.push({ kb_id: 'remove', manifest: { revision: 'index' } });
  f.state.resources.push({ owner_id: 'bob', locator: 'inputs/remove/a.md', state: 'ready' });
  await f.as('alice', () => f.service.delete('remove'));
  assert.equal(f.service.modes.remove, undefined);
  assert.equal(f.state.grants.length, 0); assert.equal(f.state.indexes.length, 0);
  assert.equal(f.state.resources[0].state, 'revoked'); assert.equal(discarded.length, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'workspace/users/bob/inputs/remove')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'workspace/users/bob/research/remove/wiki')), false);
  assert.equal(f.state.events.at(-1).action, 'knowledge:delete');
  assert.deepEqual(f.state.events.at(-1).before.grantees, ['carol']);
  await f.create('owner-delete');
  await f.as('alice', () => f.hub.publish('owner-delete'));
  await f.as('bob', () => f.service.delete('owner-delete'));
  assert.equal(await f.as('bob', () => f.hub.registerKnowledge('bob', 'owner-delete', knowledgeBinding('owner-delete'))), false);
  assert.equal(f.state.knowledge.some(r => r.id === 'owner-delete'), false);
});

test('publish/unpublish 同事务审计 detail 保留被清授权名单', async () => {
  const f = hubFixture();
  await f.as('bob', () => f.hub.grantKnowledge('general', 'carol'));
  await f.as('alice', () => f.hub.publish('general'));
  assert.deepEqual(f.state.events.at(-1).detail.revokedGrantees, ['carol']);
  assert.equal(f.state.grants.length, 0);
  await f.as('alice', () => f.hub.publish('general', false));
  assert.deepEqual(f.state.events.at(-1).detail.revokedGrantees, []);
});

test('原文导入父目录在 open 前被换成软链接：409，外部目录不留文件、不登记', async t => {
  const f = fixture(t); await f.create('race');
  const directory = path.join(f.root, 'workspace/users/bob/inputs/race');
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === path.join(directory, 'source.md')) {
      fs.renameSync(directory, directory + '-old'); fs.symlinkSync(outside, directory);
    }
    return open(file, ...args);
  });
  f.service.resources.registerImported = () => assert.fail('不能登记竞争失败的文件');
  await assert.rejects(f.as('bob', () => f.service.importSource({ kbId: 'race', name: 'source.md', content: '# private' })), e => e.status === 409);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(directory + '-old'), []);
});

test('新建目录复用 init 实现，mkdir 前父目录被替换则回滚新目录与数据库', async t => {
  const f = fixture(t), base = path.join(f.root, 'workspace/users/bob');
  fs.mkdirSync(path.join(base, 'inputs'));
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', function(file, ...args) {
    if (file === path.join(base, 'inputs/race')) {
      fs.renameSync(path.join(base, 'inputs'), path.join(base, 'old-inputs'));
      fs.symlinkSync(outside, path.join(base, 'inputs'));
    }
    return mkdir(file, ...args);
  });
  await assert.rejects(f.create('race'), e => e.status === 409);
  assert.equal(f.state.knowledge.some(r => r.id === 'race'), false);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() => prepareKnowledgeDirectories(base, { race: knowledgeBinding('race') }), e => e.status === 409);
});

test('isolated 派发：pro 用户新建库→导入→后台维护→独立 I/O 通知→wiki-effective', async t => {
  const bob = '22222222-2222-4222-8222-222222222222';
  const f = fixture(t), io = new AsyncResource('codex-stdio'), errors = [], probes = [];
  t.after(() => io.emitDestroy());
  f.state.users.find(u => u.username === 'bob').id = bob;
  f.state.knowledge[0].owner_id = bob;
  fs.mkdirSync(path.join(f.root, 'workspace/users', bob));
  await f.as('alice', () => f.hub.assign('bob', 'pro'));
  const runtime = { workspaceDir: path.join(f.root, 'workspace/users', bob) };
  Object.assign(f.agent, { execution: {}, instructions: '', runtime, descriptor: { hash: 'test' },
    workflows: defineWorkflows(f.agent.definition.agent), assertCompatible() {}, async bind() {},
    input(text) { return [{ type: 'text', text, text_elements: [] }]; } });
  const native = new FakeRpc();
  // Native stdio callbacks originate at connection startup, outside every request lease.
  native.notify = (method, params) => io.runInAsyncScope(() => {
    try { native.emit('notification', { method, params }); }
    catch (error) { errors.push(error.stack); native.emit('fatal', error); }
  });
  let starts = 0, closes = 0, messages;
  const pool = new RuntimePool({ create: async () => {
    starts++;
    const value = { rpc: native, runtime, agent: f.agent, close: async () => { closes++; } };
    router.attach(value, bob); return value;
  }, onLost: (owner, error) => messages.failOwner(owner, error) });
  const router = new RuntimeRouter(pool, { isolated: true });
  const config = { root: f.root, agent: f.agent, launch: { timeoutMs: 3000 }, memory: {} };
  const hub = { publish() {} }, repository = { conversation: async () => ({ hub_knowledge: [] }), query: async () => {}, recordArtifacts: async () => {} };
  const sessions = new SessionService({ rpc: router, config, runtime, hub, repository, redact: String,
    permissionHub: f.hub, boundary: new ExecutionBoundary(), beforeTurn: async () => {
      probes.push([currentIdentity().userId, Boolean(pool.current(bob))]);
      assert.equal(sessions.userRuntime(), runtime);
    } });
  config.agent = router.agent(f.agent); f.gate.agent = config.agent;
  router.sessions = sessions;
  router.on('notification', ({ method, params }) => {
    if (method === 'turn/started') f.gate.started(params.threadId, params.turn.id);
    if (method === 'turn/completed') f.gate.end(params.threadId, params.turn.id);
  });
  const store = new TestJobs();
  messages = new MessageService({ rpc: router, sessions, store, config, hub, gate: f.gate, permissionHub: f.hub });
  t.after(async () => { await messages.close(); sessions.close(); await pool.close(); });
  const as = operation => router.withOwner(bob, () => f.as(bob, operation));
  await as(() => f.service.create({ kbId: 'bob-notes', title: 'Bob notes' }));
  await as(() => f.service.importSource({ kbId: 'bob-notes', name: 'source.md', content: '# source' }));
  const session = await as(() => sessions.create());
  messages.queue = { close: async () => {} };
  await as(() => messages.submit({ threadId: session.id, clientMessageId: 'isolated-maintain', text: '维护知识库',
    workflow: 'knowledge-maintain', params: { kbId: 'bob-notes' } }));
  runOwner('carol', () => messages.schedule(session.id));
  await until(() => store.get('isolated-maintain').status !== 'queued');
  await messages.drain;
  assert.equal(store.get('isolated-maintain').status, 'running', JSON.stringify({ job: store.get('isolated-maintain'), errors, probes }));
  const turn = native.threads.get(session.id).turns.at(-1);
  const item = { id: 'revision', type: 'dynamicToolCall', tool: 'kb_submit_revision', status: 'completed',
    result: { content: [{ type: 'text', text: JSON.stringify({ effective: true, kbId: 'bob-notes', slug: 'page', versionId: 'v1' }) }] } };
  native.notify('item/completed', { threadId: session.id, turnId: turn.id, item });
  native.finish(session.id);
  await until(() => store.get('isolated-maintain').status !== 'running');
  const job = store.get('isolated-maintain');
  assert.equal(job.status, 'completed', JSON.stringify({ job, errors }));
  assert.deepEqual(job.checks.map(c => [c.id, c.passed]), [['wiki-effective', true]]);
  assert.ok(probes.every(([owner, current]) => owner === bob && current));
  assert.deepEqual(errors, []); assert.equal(starts, 1); assert.equal(closes, 0);
  assert.equal(store.paused(session.id), false);
});


test('配置型 general 首次导入：元数据已存在、owner 源目录缺失也能登记；外人不建目录', async t => {
  const f = fixture(t), target = path.join(f.root, 'workspace/users/bob/inputs/general');
  f.agent.definition.agent.knowledge = [{ kbId: 'general', mode: 'wiki', actions: ['read','update','index'] }];
  f.agent.definition.bindings.knowledgeBases = { general: { sourceRoot: 'inputs/general', wikiRoot: 'research/general/wiki' } };
  assert.equal(fs.existsSync(target), false);
  await assert.rejects(f.as('dave', () => f.service.importSource({ kbId: 'general', name: 'tea.md', content: '茶叶' })), { status: 404 });
  assert.equal(fs.existsSync(target), false);
  await f.as('bob', () => f.service.importSource({ kbId: 'general', name: 'tea.md', content: '茶叶' }));
  assert.equal(fs.readFileSync(path.join(target, 'tea.md'), 'utf8'), '茶叶');
  await assert.rejects(f.as('bob', () => f.service.importSource({ kbId: 'general', name: 'tea.md', content: '禁止覆盖' })), { status: 409 });
  assert.equal(fs.readFileSync(path.join(target, 'tea.md'), 'utf8'), '茶叶');
});

test('跨分片资源 RPC：isolated=true 且 owner 节点没有请求者运行环境，仍按请求者授权读取', async t => {
  const { attachKnowledge } = await import('../server/modules/sharding/knowledge.mjs');
  const { shardUser } = await import('../server/modules/sharding/fence.mjs');
  const f = fixture(t);
  f.agent.definition.agent.knowledge = [{ kbId: 'general', mode: 'wiki', actions: ['read','update','index'] }];
  f.agent.definition.bindings.knowledgeBases = { general: { sourceRoot: 'inputs/general', wikiRoot: 'research/general/wiki' } };
  await f.as('bob', () => f.service.importSource({ kbId: 'general', name: 'tea.md', content: '茶叶' }));
  await f.as('bob', () => f.hub.grantKnowledge('general', 'carol'));
  const pool = new RuntimePool({ create: () => assert.fail('资源 RPC 不能启动请求者运行环境') });
  const router = new RuntimeRouter(pool, { isolated: true });
  f.gate.agent = router.agent(f.agent);
  f.service.resources.readById = async () => assert.fail('not used');
  let reads = 0;
  f.service.read = async () => {
    f.gate.check('read', { kbId: 'general' });
    assert.equal(currentIdentity().userId, 'carol'); assert.equal(shardUser(), 'bob'); reads++;
    return { content: fs.readFileSync(path.join(f.root, 'workspace/users/bob/inputs/general/tea.md'), 'utf8') };
  };
  const runtime = { nodeId: 'node-c', cache: { revision: '1', routeOf: () => ({ primary: 'node-c', revision: '1' }) },
    coordination: { members: new Map() }, admit: async owner => assert.equal(owner, 'bob') };
  attachKnowledge({ accounts: { authenticate: async token => ({ userId: token.slice(7) }) }, knowledge: f.service, resources: f.service.resources, permissionHub: f.hub, gate: f.gate }, runtime);
  const read = requester => runtime.readKnowledge({ action: 'read', args: { kbId: 'general', slug: 'tea' }, revision: '1' }, 'Bearer ' + requester);
  assert.equal((await read('carol')).content, '茶叶');
  await assert.rejects(read('dave'), { status: 404 });
  await runOwner('bob', () => f.hub.withUser('bob', () => f.hub.revoke('knowledge', 'general', 'carol')));
  await assert.rejects(read('carol'), { status: 404 });
  assert.equal(reads, 1); assert.equal(pool.entries.size, 0);
  // No general fallback: personal operations still require the actual user's runtime.
  await runOwner('carol', () => assert.throws(() => f.gate.user(), { code: 'RUNTIME_BUSY' }));
});

test('跨分片 HTTP：真实 Accounts 与 Hub 经任意入口认证、授权、拒绝写入和撤销，无请求者运行环境', async t => {
  const { Readable, Writable } = await import('node:stream');
  const { Accounts } = await import('../server/modules/accounts/index.mjs');
  const { tokenHash } = await import('../server/modules/accounts/password.mjs');
  const { attachKnowledge } = await import('../server/modules/sharding/knowledge.mjs');
  const { createShardedHandler } = await import('../server/modules/sharding/http.mjs');
  const { ShardRuntime } = await import('../server/modules/sharding/runtime.mjs');
  const { shardUser } = await import('../server/modules/sharding/fence.mjs');
  const { createHttpService } = await import('../server/modules/http/index.mjs');
  const { authHeaders, nodeAuth } = await import('./fixtures/node-auth.mjs');
  const f = fixture(t), logs = [], nodes = new Map(), members = new Map();
  f.agent.definition.agent.knowledge = [{ kbId: 'general', mode: 'wiki', actions: ['read','update','index'] }];
  f.agent.definition.bindings.knowledgeBases = { general: { sourceRoot: 'inputs/general', wikiRoot: 'research/general/wiki' } };
  await f.as('bob', () => f.service.importSource({ kbId: 'general', name: 'tea.md', content: '茶叶' }));
  await f.as('bob', () => f.hub.grantKnowledge('general', 'carol'));
  const runtimePool = new RuntimePool({ create: () => assert.fail('read-only HTTP cannot create a runtime') });
  f.gate.agent = new RuntimeRouter(runtimePool, { isolated: true }).agent(f.agent);
  const now = Date.now(), tokens = { carol: 'c'.repeat(43), dave: 'd'.repeat(43) };
  const sessions = new Map(Object.entries(tokens).map(([id, token]) => [tokenHash(token), {
    ...f.state.users.find(u => u.id === id), session_id: id, created_at: now, last_seen_at: now, expires_at: now + 600000,
  }]));
  const accounts = new Accounts({ session: async hash => sessions.get(hash), touch: () => assert.fail('fresh session') }, { now: () => now });
  const routeOf = user => ({ shardId: user === 'bob' ? '2' : '0', primary: user === 'bob' ? 'node-c' : 'node-a', epoch: 1, revision: '1' });
  let reads = 0;
  for (const nodeId of ['node-a', 'node-c']) {
    const cache = { revision: '1', routeOf, refresh: async () => {} }, coordination = { members, checkLease: () => true };
    const runtime = new ShardRuntime({ nodeId, cache, coordination, ...nodeAuth(nodeId) });
    const pool = { query: async (sql, args) => {
      if (sql.startsWith('SELECT u.paused')) return { rows: [{ paused: false, shard_id: routeOf(args[0]).shardId }] };
      if (sql.startsWith('SELECT owner_id')) return { rows: [{ owner_id: 'bob' }] };
      if (sql.startsWith('SELECT 1')) return { rows: [{}] };
      assert.fail(sql);
    } };
    runtime.pool = pool;
    const knowledge = Object.create(f.service);
    knowledge.query = (sql, args) => sql.startsWith('SELECT effective_mode') ? { rows: [{ effective_mode: 'wiki' }] } : f.service.query(sql, args);
    knowledge.read = async () => {
      f.gate.check('read', { kbId: 'general' });
      assert.equal(currentIdentity().userId, 'carol'); assert.equal(shardUser(), 'bob');
      assert.equal(nodeId, 'node-c'); reads++;
      return { content: fs.readFileSync(path.join(f.root, 'workspace/users/bob/inputs/general/tea.md'), 'utf8') };
    };
    const read = knowledge.read;
    knowledge.search = async () => ({ hits: [await read()] });
    const app = { accounts, knowledge, resources: { ...f.service.resources, readById: () => assert.fail('not used') },
      permissionHub: f.hub, gate: f.gate, data: { pool, scope: { instanceId: 'test' } },
      config: { root: f.root, sharding: runtime }, sessions: { rpc: { pool: runtimePool } }, redact: JSON.stringify, log: line => logs.push(line) };
    attachKnowledge(app, runtime);
    app.http = createHttpService(app);
    t.after(() => app.http.close());
    nodes.set(nodeId, createShardedHandler(coordination, { app, isReady: () => true }, runtime, {}));
    members.set(nodeId, { nodeId, address: `http://${nodeId}` });
  }
  // Real handlers, forwardHttp and internal client; only socket transport is replaced.
  const request = async (node, pathname, { method = 'POST', headers = {}, body } = {}) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { url: pathname, method, headers });
    const chunks = [], res = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
    let status, responseHeaders;
    res.writeHead = (code, value) => { status = code; responseHeaders = value; res.headersSent = true; };
    res.flushHeaders = () => {};
    await nodes.get(node)(req, res);
    return new Response(Buffer.concat(chunks), { status, headers: responseHeaders });
  };
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/internal/knowledge') {
      assert.equal(options.headers.authorization, `Bearer ${tokens.carol}`);
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'requester'), false);
    }
    return request(url.hostname, url.pathname + url.search, options);
  });
  const api = (node, user, pathname = '/knowledge/search') => request(node, pathname, {
    headers: { authorization: `Bearer ${tokens[user]}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kbId: 'general', query: '茶叶', name: 'forbidden.md', content: 'forbidden' }),
  });
  for (const node of nodes.keys()) {
    const result = await api(node, 'carol'); assert.equal(result.status, 200);
    assert.equal((await result.json()).hits[0].content, '茶叶');
    assert.equal((await api(node, 'dave')).status, 404);
    assert.equal((await api(node, 'carol', '/knowledge/source')).status, 403);
  }
  assert.equal(reads, 2);
  const internalBody = { action: 'search', args: { kbId: 'general', query: '茶叶' }, revision: '1' };
  const internal = (body, authorization) => request('node-c', '/internal/knowledge', {
    headers: { ...authHeaders('node-a'), 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await internal(internalBody)).status, 401);
  assert.equal((await internal({ ...internalBody, requester: 'bob' }, `Bearer ${tokens.carol}`)).status, 403);
  await runOwner('bob', () => f.hub.withUser('bob', () => f.hub.revoke('knowledge', 'general', 'carol')));
  for (const node of nodes.keys()) assert.equal((await api(node, 'carol')).status, 404);
  assert.equal((await internal(internalBody, `Bearer ${tokens.carol}`)).status, 404, 'owner takes a fresh grant snapshot');
  sessions.get(tokenHash(tokens.carol)).revoked_at = now;
  assert.equal((await internal(internalBody, `Bearer ${tokens.carol}`)).status, 401);
  assert.equal(reads, 2); assert.equal(runtimePool.entries.size, 0); assert.deepEqual(logs, []);
});
