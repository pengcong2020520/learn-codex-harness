// Teaching fixtures call real modules; they do not claim to validate PostgreSQL or Chroma.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { KnowledgeService } from '../server/modules/knowledge/index.mjs';

function agentFixture(mode = 'wiki') {
  return {
    assertCurrent() {}, allowsTool: name => ['read_file', 'kb_read'].includes(name),
    sources: [{ locator: 'inputs', actions: ['read'] }, { locator: 'research', actions: ['read', 'create'] }],
    outputs: { directory: 'outputs' },
    definition: { agent: { id: 'lesson', knowledge: [{ kbId: 'a', mode, actions: ['read', 'update'] }] },
      bindings: { knowledgeBases: { a: { sourceRoot: 'inputs/a', wikiRoot: 'research/a/wiki' } } } },
  };
}

test('挂载边界：注册但未挂载的 KB 不能借宽泛 inputs 来源读取', async () => {
  const agent = agentFixture();
  const gate = new PermissionGate({ scope: { ownerId: 'owner' }, agent });
  // Production KnowledgeService.open builds this registry from PG, including other Agents' KBs.
  gate.knowledgeBases = Object.freeze({
    a: { sourceRoot: 'inputs/a', wikiRoot: 'research/a/wiki' },
    b: { sourceRoot: 'inputs/b', wikiRoot: 'research/b/wiki' },
  });
  gate.start({ id: 'ordinary', threadId: 'thread' });
  gate.started('thread', 'turn');
  await gate.run(gate.forTurn('thread', 'turn'), () => {
    assert.doesNotThrow(() => gate.check('read', { path: 'inputs/a/source.md' }));
    assert.doesNotThrow(() => gate.check('read', { kbId: 'a' }));
    assert.throws(() => gate.check('read', { path: 'inputs/b/source.md' }), /未授权/);
    assert.throws(() => gate.check('read', { kbId: 'b' }), /未授权/);
    assert.throws(() => gate.check('read', { kbId: 'a', ownerId: 'another' }), /未授权/);
    assert.throws(() => gate.check('create', { path: 'research/a/wiki/fake.md' }), /未授权/);
  });
  gate.end('thread', 'turn');
});

function modeFixture({ previous = null, ready = false, revision = null } = {}) {
  const agent = agentFixture('rag');
  const state = { previous, ready, revision, calls: [], mounts: [] };
  // Only database responses are stubbed. Unexpected SQL fails instead of returning generic success.
  const pool = { async query(sql, params) {
    state.calls.push({ sql, params });
    assert.equal(params[0], 'instance'); assert.equal(params[1], 'owner');
    if (sql.startsWith('INSERT INTO agent_data.knowledge_bases')) return { rowCount: 1, rows: [{ id: 'a' }] };
    if (sql.startsWith('SELECT id,source_root,wiki_root')) return { rows: [{ id: 'a', source_root: 'inputs/a', wiki_root: 'research/a/wiki' }] };
    if (sql.startsWith('SELECT * FROM agent_data.knowledge_bases')) return { rows: [{ id: 'a', index_revision: state.revision }] };
    if (sql.startsWith('SELECT effective_mode')) return { rows: state.previous ? [{ effective_mode: state.previous }] : [] };
    if (sql.startsWith('INSERT INTO agent_data.knowledge_mounts')) {
      state.mounts.push(params.slice(2)); state.previous = params[5]; return { rowCount: 1, rows: [] };
    }
    throw new Error('Unexpected fixture SQL: ' + sql);
  } };
  const rag = { async ready() { return state.ready; } };
  const create = () => new KnowledgeService(pool, { instanceId: 'instance', ownerId: 'owner' }, { agent, gate: {}, resources: {}, rag });
  return { state, create };
}

test('模式边界：首次 RAG 未就绪保持 Wiki，保留期望 RAG', async () => {
  const { state, create } = modeFixture();
  const knowledge = await create().open();
  assert.equal(knowledge.modes.a, 'wiki');
  assert.deepEqual(state.mounts, [['lesson', 'a', 'rag', 'wiki']]);
  assert.ok(Object.isFrozen(knowledge.gate.knowledgeBases));
});

test('模式边界：索引变为就绪不会热切换，重新 open 才采用 RAG', async () => {
  const { state, create } = modeFixture();
  const knowledge = await create().open();
  state.revision = 'index-v1'; state.ready = true;
  assert.equal(knowledge.modes.a, 'wiki');
  const restarted = await create().open();
  assert.equal(restarted.modes.a, 'rag');
  assert.equal(knowledge.modes.a, 'wiki');
  assert.deepEqual(state.mounts.at(-1), ['lesson', 'a', 'rag', 'rag']);
});

test('模式边界：已生效 RAG 不可用必须报错，不能静默回退 Wiki', async () => {
  const { state, create } = modeFixture({ previous: 'rag', revision: 'index-v1', ready: false });
  await assert.rejects(create().open(), error => error.code === 'RAG_NOT_READY');
  assert.deepEqual(state.mounts, [], '失败不得保存 Wiki 作为替代模式');
});
