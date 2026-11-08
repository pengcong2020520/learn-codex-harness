import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentDefinition, digest } from '../server/modules/agents/index.mjs';
import { modelContract } from '../server/modules/agents/contracts.mjs';
import { createModelRouter } from '../server/modules/gateway/router.mjs';
import { loadModelRegistry } from '../server/modules/gateway/index.mjs';
import { KnowledgeService } from '../server/modules/knowledge/index.mjs';
import { ToolManager } from '../server/modules/tools/index.mjs';
import { createFileTools } from '../server/modules/data/files.mjs';
import { createRuntimes } from '../server/modules/runtimes/index.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { EventHub } from '../server/modules/events/index.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { prepareRun, finishRun } from '../server/modules/codex/runtime.mjs';
import { runOwner, currentIdentity } from '../server/modules/accounts/context.mjs';
import { FakeRpc, fixture, installToolFixture, tempRoot } from './helpers.mjs';

const bob = '11111111-1111-4111-8111-111111111111';
const admin = '22222222-2222-4222-8222-222222222222';
const incompatible = { code: 'AGENT_INCOMPATIBLE', status: 409 };
function edit(file, change) {
  const value = JSON.parse(fs.readFileSync(file)); change(value);
  fs.writeFileSync(file, JSON.stringify(value));
}

// Persistent repository/native history doubles; all assembly, Skill installation,
// verification, tool contracts, knowledge startup and session compatibility are real.
function cluster() {
  const conversations = new Map(), native = new Map(), descriptors = new Map();
  const repository = {
    saveAgent: async value => descriptors.set(value.hash, value),
    agentDescriptor: async hash => descriptors.get(hash),
    bind: async (id, hash, cwd) => conversations.set(id, { id, agent_hash: hash, cwd, owner_id: currentIdentity().userId }),
    conversation: async id => {
      const row = conversations.get(id); assert.equal(row?.owner_id, currentIdentity().userId); return row;
    },
    recordArtifacts: async () => {},
  };
  return { repository, conversations, native, descriptors, registered: [] };
}

async function boot(t, state, root, nodeId = 'node-a', environment = {}) {
  const config = loadServerConfig(root, { ...fixture, AGENT_MEMORY_USE: 'false',
    CODEX_MODEL_CATALOG_ENABLED: 'true', CODEX_MODEL_CONTEXT_WINDOW: '128000', ...environment });
  const base = new AgentDefinition(root);
  const runtime = await prepareRun(config.launch, root, { workspaceDir: base.workspacePath });
  base.configure(config, runtime); base.repository = state.repository;
  config.sharding = { nodeId, assertPrimary: () => {}, owns: owner => owner === bob };
  // Admin/default KB lives on another shard. Its registration may complete after
  // node-a's first startup, exactly the s17 multi-primary startup ordering.
  const knowledge = new KnowledgeService({}, { instanceId: admin, ownerId: admin }, {
    agent: base, gate: {}, sharding: config.sharding,
  });
  knowledge.query = async (sql, values) => {
    if (sql.startsWith('SELECT id,source_root')) return { rows: state.registered };
    if (sql.startsWith('SELECT * FROM agent_data.knowledge_bases')) return { rows: state.registered.filter(r => r.id === values[0]) };
    if (sql.startsWith('SELECT effective_mode')) return { rows: [{ effective_mode: 'wiki' }] };
    throw new Error(`Unexpected knowledge write: ${sql}`);
  };
  await knowledge.open(); base.knowledgeModes = knowledge.modes;
  const files = createFileTools(root, { workspaceDir: base.workspacePath, sources: base.sources, outputs: base.outputs });
  const tools = new ToolManager({ config, runtime, agent: base, files, knowledge, gate: {}, log: () => {}, redact: String });
  await tools.open();
  const store = { ensure: async owner => ({ user_id: owner, uid: 10001, codex_home: path.join(root, '.data/users', owner, 'codex') }),
    assertEnabled: async () => {}, listen: async () => async () => {} };
  const connections = [];
  const service = createRuntimes({ config, data: { scope: { instanceId: admin }, repository: state.repository, jobs: { list: async () => [] } },
    agent: base, tools, store, isolated: false, log: () => {}, redact: String,
    connection: ({ runtime: userRuntime }) => {
      const rpc = new FakeRpc(); rpc.threads = state.native;
      rpc.open = async () => {}; rpc.close = async () => { rpc.closing = true; };
      const request = rpc.request.bind(rpc);
      rpc.request = async (method, params, options) => {
        if (method === 'skills/list') return { data: [{ skills: base.skills.map(s => ({ name: s.id, path: path.join(userRuntime.codexHome, 'skills', s.id, 'SKILL.md'), enabled: true })) }] };
        if (method === 'mcpServerStatus/list') return { data: [] };
        if (method === 'config/read') return { config: { features: { memories: config.memory.enabled, shell_tool: false }, memories: {
          use_memories: config.memory.use, generate_memories: config.memory.generate, extract_model: config.memory.extractModel,
          consolidation_model: config.memory.consolidationModel, min_rollout_idle_hours: config.memory.minIdleHours,
        } } };
        return request(method, params, options);
      };
      connections.push(rpc); return rpc;
    } });
  const sessions = new SessionService({ rpc: service.rpc, config, runtime, repository: state.repository, hub: new EventHub(), redact: String });
  config.agent = service.agent; service.attach({ sessions });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; sessions.close(); await service.rpc.close(); await tools.close(); await finishRun(runtime.runDir); };
  t.after(close);
  return { base, config, runtime, service, sessions, connections, close,
    asBob: operation => runOwner(bob, () => service.rpc.withOwner(bob, operation)) };
}

test('s17 restart: start → create and complete turn → close → same config → resume with late remote KB registration', async t => {
  const root = installToolFixture(tempRoot(t), { knowledge: true, article: true }), state = cluster();
  const first = await boot(t, state, root);
  const thread = await first.asBob(async value => {
    const created = await first.sessions.create();
    await value.rpc.request('turn/start', { threadId: created.id, input: [{ type: 'text', text: 'hello' }] });
    value.rpc.finish(created.id);
    return created;
  });
  const hash = state.conversations.get(thread.id).agent_hash;
  const firstRun = first.runtime.runDir;
  assert.ok(fs.existsSync(first.runtime.catalogFile));
  await first.close();
  assert.ok(first.connections.every(rpc => rpc.closing));
  state.registered.push({ id: 'general', owner_id: admin, source_root: 'inputs/general', wiki_root: 'research/general/wiki' });
  const restarted = await boot(t, state, root);
  assert.notEqual(restarted.runtime.runDir, firstRun);
  assert.notEqual(restarted.runtime.catalogFile, first.runtime.catalogFile);
  await restarted.asBob(async value => {
    const resumed = await restarted.sessions.ensure(thread.id);
    assert.equal(resumed.turns[0].status, 'completed');
    assert.equal(value.agent.descriptor.hash, hash);
    await value.agent.assertCompatible(thread.id, hash); // queued message binding too
    assert.equal(value.rpc.calls.filter(call => call.method === 'thread/resume').length, 1);
  });
});

test('s17 pre-fix persisted v2: restore by verified policy evidence; unknown hashes, changed policies and corrupt descriptors fail closed', async t => {
  const root = installToolFixture(tempRoot(t), { knowledge: true, article: true }), state = cluster();
  const first = await boot(t, state, root);
  const thread = await first.asBob(() => first.sessions.create());
  const current = state.descriptors.get(state.conversations.get(thread.id).agent_hash);
  // Exact pre-fix activate() format, including absolute paths and the empty
  // knowledge snapshot captured before the other shard registers general.
  const { hash: _hash, modelPolicy: _policy, ...payload } = current;
  const legacy = { ...payload, workspaceDir: first.base.workspacePath, knowledgeModes: {},
    skills: current.skills.map(({ id, ...skill }) => ({ ...skill, path: path.join(root, '.data/codex/skills', id, 'SKILL.md') })) };
  legacy.hash = digest(legacy);
  const saved = JSON.stringify(legacy);
  state.descriptors.set(legacy.hash, legacy); state.conversations.get(thread.id).agent_hash = legacy.hash;
  await first.close();
  state.registered.push({ id: 'general', owner_id: admin, source_root: 'inputs/general', wiki_root: 'research/general/wiki' });
  const restarted = await boot(t, state, root);
  await restarted.asBob(async value => {
    await restarted.sessions.ensure(thread.id);
    await value.agent.assertCompatible(thread.id, legacy.hash);
    await assert.rejects(value.agent.assertCompatible(thread.id, 'f'.repeat(64)), incompatible);
    state.descriptors.set(legacy.hash, { ...legacy, roleHash: 'corrupt' });
    await assert.rejects(value.agent.assertCompatible(thread.id), incompatible);
    state.descriptors.set(legacy.hash, legacy);
  });
  await restarted.close();
  const roleFile = first.base.roleFile, originalRole = fs.readFileSync(roleFile);
  for (const change of [
    () => fs.appendFileSync(roleFile, '\nChanged role.'),
    () => edit(path.join(root, 'config/tools/files.json'), v => { v.contractVersion = 3; }),
  ]) {
    fs.writeFileSync(roleFile, originalRole); change(); const changed = await boot(t, state, root);
    await changed.asBob(() => assert.rejects(changed.sessions.ensure(thread.id), incompatible));
    await changed.close();
  }
  assert.equal(JSON.stringify(state.descriptors.get(legacy.hash)), saved);
  assert.equal(state.conversations.get(thread.id).agent_hash, legacy.hash);
});

test('s17 model policy: deployment endpoints/keys ignored; model, capabilities, routing and native search remain semantic', async t => {
  const root = installToolFixture(tempRoot(t)), config = loadServerConfig(root, fixture);
  const baseline = modelContract(config.launch);
  assert.deepEqual(modelContract({ ...config.launch, args: ['model_catalog_json=/other/.runs/random/models.json'],
    env: { CODEX_HOME: '/other/home', CODEX_API_KEY: 'rotated' }, baseUrl: 'http://node-b:9999/v1' }), baseline);
  for (const change of [{ model: 'other-model' }, { webSearch: 'live' }])
    assert.notEqual(digest(modelContract({ ...config.launch, ...change })), digest(baseline));
  const registry = loadModelRegistry(path.resolve(import.meta.dirname, '..'));
  const environment = { AGENT_ENABLED_PROVIDERS: Object.keys(registry.providers).join(',') };
  const router = registry => createModelRouter(registry, environment).contract();
  const original = router(registry), updated = structuredClone(registry);
  updated.scenes = { ...updated.scenes, test: Object.keys(updated.models).slice(0, 1) };
  assert.notEqual(digest(router(updated)), digest(original));
});

test('s17 node-a/node-b: same Agent at different roots, workspace/CODEX_HOME/ports has identical fingerprint', async t => {
  const state = cluster();
  const roots = [installToolFixture(tempRoot(t), { article: true }), installToolFixture(tempRoot(t), { article: true })];
  const nodes = [];
  for (let i = 0; i < roots.length; i++) {
    // Absolute deployment bindings can differ while logical resource rules stay identical.
    edit(path.join(roots[i], 'agents/writing/agent.json'), v => { v.bindings.workspaceDir = path.join(roots[i], 'workspace'); });
    nodes.push(await boot(t, state, roots[i], `node-${i ? 'b' : 'a'}`, { AGENT_PORT: String(4340 + i), CODEX_BASE_URL: `http://localhost:${8000 + i}/v1` }));
  }
  const values = await Promise.all(nodes.map(n => n.asBob(value => ({ descriptor: value.agent.descriptor, runtime: value.runtime, input: value.agent.input('$write-article') }))));
  assert.notEqual(values[0].runtime.codexHome, values[1].runtime.codexHome);
  assert.notEqual(values[0].input.at(-1).path, values[1].input.at(-1).path);
  assert.deepEqual(values[0].descriptor, values[1].descriptor);
});

test('s17 semantic changes still reject old session and queued message before native resume', async t => {
  const root = installToolFixture(tempRoot(t), { article: true }), state = cluster();
  const agentFile = path.join(root, 'agents/writing/agent.json'), toolFile = path.join(root, 'config/tools/files.json');
  const originalAgent = fs.readFileSync(agentFile), originalTool = fs.readFileSync(toolFile);
  const first = await boot(t, state, root);
  const thread = await first.asBob(() => first.sessions.create());
  const hash = state.conversations.get(thread.id).agent_hash;
  await first.close();
  const roleFile = first.base.roleFile, skillFile = first.base.skills[0].path;
  const originalRole = fs.readFileSync(roleFile), originalSkill = fs.readFileSync(skillFile);
  for (const change of [
    () => edit(agentFile, v => { v.agent.outputs.formats = ['txt']; }),
    () => edit(toolFile, v => { v.contractVersion = 2; }),
    () => edit(toolFile, v => { v.tools[0].inputSchema.properties.path.maxLength = 42; }),
    () => fs.appendFileSync(roleFile, '\nChanged role.'),
    () => fs.appendFileSync(skillFile, '\nChanged Skill.'),
  ]) {
    fs.writeFileSync(agentFile, originalAgent); fs.writeFileSync(toolFile, originalTool);
    fs.writeFileSync(roleFile, originalRole); fs.writeFileSync(skillFile, originalSkill); change();
    const changed = await boot(t, state, root);
    await changed.asBob(async value => {
      await assert.rejects(changed.sessions.ensure(thread.id), incompatible);
      assert.throws(() => value.agent.checkBinding(value.agent.descriptor.hash, hash), incompatible);
      assert.equal(value.rpc.calls.some(call => call.method === 'thread/resume'), false);
    });
    await changed.close();
  }
  fs.writeFileSync(agentFile, originalAgent); fs.writeFileSync(toolFile, originalTool);
  fs.writeFileSync(roleFile, originalRole); fs.writeFileSync(skillFile, originalSkill);
  const changedModel = await boot(t, state, root, 'node-a', { CODEX_MODEL: 'other-model',
    AGENT_MEMORY_EXTRACT_MODEL: 'unit-model', AGENT_MEMORY_CONSOLIDATION_MODEL: 'unit-model' });
  await changedModel.asBob(() => assert.rejects(changedModel.sessions.ensure(thread.id), incompatible));
});

test('s17 Skill discovery order is stable; effective RAG transition remains incompatible', async t => {
  const root = installToolFixture(tempRoot(t), { knowledge: true, article: true }), state = cluster();
  const node = await boot(t, state, root);
  await node.asBob(async value => {
    const thread = await node.sessions.create(), agent = value.agent, hash = agent.descriptor.hash;
    await agent.activate(node.service.pool.current(bob).agent.descriptor.toolVersion, [...agent.availableSkills].reverse());
    assert.equal(agent.descriptor.hash, hash);
    agent.knowledgeModes = { general: 'rag' };
    await agent.activate(agent.descriptor.toolVersion);
    await assert.rejects(node.sessions.ensure(thread.id), incompatible);
  });
});
