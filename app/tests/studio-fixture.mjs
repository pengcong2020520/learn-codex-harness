import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runIdentity } from '../server/modules/accounts/context.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { createFileTools } from '../server/modules/data/files.mjs';
import { createDesignTools } from '../server/modules/design/index.mjs';
import { loadServerConfig, createLogRedactor } from '../server/modules/config/index.mjs';
import { prepareRun } from '../server/modules/codex/runtime.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { MessageService } from '../server/modules/messages/index.mjs';
import { EventHub } from '../server/modules/events/index.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { accountFixture, httpFixture, request } from './accounts-fixture.mjs';
import { hubFixture } from './hub-fixture.mjs';
import { TestJobs } from './jobs-fixture.mjs';
import { FakeRpc, fixture, installToolFixture, tempRoot, cleanup, until } from './helpers.mjs';

const fixtures = path.join(import.meta.dirname, 'fixtures/studio');
const owner = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const admin = work => runIdentity({ userId: owner, role: 'admin' }, work);
const prefix = 'outputs/design/task-helper/';
const read = file => fs.readFileSync(path.join(fixtures, file), 'utf8');
function children(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? children(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]).sort();
}

// 沿用 FakeRpc 的真实 turn/started、dynamicToolCall 与 turn/completed 形状；产物经实际受限文件服务写入。
export class StudioCodex extends FakeRpc {
  async produce(threadId, files, toolFiles, design, overrides = {}) {
    const read = file => overrides[file] ?? fs.readFileSync(path.join(fixtures, file), 'utf8');
    const turnId = this.threads.get(threadId).turns.at(-1).id;
    let index = 0;
    const notify = (tool, args, result) => this.notify('item/completed', { threadId, turnId, item: {
      type: 'dynamicToolCall', id: `${turnId}-tool-${++index}`, tool, status: 'completed', success: true,
      arguments: args, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
    } });
    this.designReports ??= new Map();
    const write = (file, content) => {
      const args = { path: prefix + file, content };
      notify('write_file', args, toolFiles.write_file(args));
    };
    const check = async file => {
      const args = { path: prefix + file }, result = await design.check_design(args);
      assert.equal(result.status, 'completed'); assert.equal(result.errors, 0);
      notify('check_design', args, result);
      const reportArgs = { path: result.reportPath };
      notify('read_file', reportArgs, toolFiles.read_file(reportArgs));
      const report = { artifact: file, reportPath: result.reportPath.slice(prefix.length),
        status: result.status, errors: result.errors, warnings: result.warnings };
      this.designReports.set(file, report);
      return report;
    };
    let selected;
    const withTokens = html => html.replace(/:root\{[^}]*\}/, () => `:root{${Object.entries({ ...selected.style, ...selected.theme }).map(([key, value]) => `${key}:${value};`).join('')}}`)
      .replace(/const baseTokens=.*;\n/, () => `const baseTokens=${JSON.stringify({ style: selected.style, theme: selected.theme })};\n`);
    if (files.includes('theme-v1.json')) {
      for (const file of ['inputs/drafts/theme.json', prefix + 'themes-r1.json']) {
        const args = { path: file }; notify('read_file', args, toolFiles.read_file(args));
      }
      const draft = JSON.parse(toolFiles.read_file({ path: 'inputs/drafts/theme.json' }).content);
      const candidates = JSON.parse(toolFiles.read_file({ path: prefix + 'themes-r1.json' }).content);
      assert.ok(candidates.styles.some(item => item.id === draft.styleId));
      assert.ok(candidates.themes.some(item => item.id === draft.themeId));
      assert.ok(files.indexOf('theme-v1.json') < files.indexOf('prototype-v1.html'));
      selected = JSON.parse(read('theme-v1.json'));
      const style = candidates.styles.find(item => item.id === draft.styleId);
      const theme = candidates.themes.find(item => item.id === draft.themeId);
      selected.name = `${style.name} · ${theme.name}`;
      selected.style = style.tokens; selected.theme = theme.tokens;
      selected.confirmationEvidence = `测试输入：选择 ${draft.styleId} 与 ${draft.themeId} 后确认进入 hifi`;
      const sample = candidates.samples.find(item => item.styleId === draft.styleId && item.themeId === draft.themeId
        && item.designReport.status === 'completed' && item.designReport.errors === 0);
      const samplePath = sample?.artifact || 'theme-sample-v4.html';
      if (!sample) {
        write(samplePath, withTokens(read('theme-sample-v1.html')));
        await check(samplePath);
      }
      selected.source = { ...selected.source, styleId: draft.styleId, themeId: draft.themeId,
        styleRound: draft.styleRound ?? draft.round, themeRound: draft.themeRound ?? draft.round, sample: samplePath };
      selected.designReport = this.designReports.get(samplePath);
      assert.ok(selected.designReport, '主题夹具必须引用本次工具返回的实际报告');
    }
    for (const file of files) {
      const content = file === 'theme-v1.json' ? JSON.stringify(selected)
        : selected && /^prototype-v\d+\.html$/.test(file) ? withTokens(read(file)) : read(file);
      write(file, content);
      if (/^(?:wireframe|prototype|theme-sample)-v\d+\.html$/.test(file)) {
        await check(file);
      }
    }
    if (files.includes('package-v1/manifest.json')) {
      const args = { path: prefix + 'package-v1' }, result = await design.check_agent_package(args);
      assert.equal(result.ok, true, JSON.stringify(result)); notify('check_agent_package', args, result);
      const report = { schemaVersion: 1, projectId: 'task-helper', ...args, ...result, status: 'completed', reason: null };
      const write = { path: prefix + 'qa/package-check.json', content: JSON.stringify(report) };
      notify('write_file', write, toolFiles.write_file(write));
    }
    this.finish(threadId);
  }
}

export async function studioRig(t, { initialDrafts = true, vision = false } = {}) {
  const root = installToolFixture(tempRoot(t));
  fs.copyFileSync(path.join(import.meta.dirname, '../config/models.json'), path.join(root, 'config/models.json'));
  fs.writeFileSync(path.join(root, 'config/runtime/project.json'), JSON.stringify({ agentDefinition: 'agents/studio/agent.json' }));
  const config = loadServerConfig(root, fixture), runtime = await prepareRun(config.launch, root);
  if (vision) config.registry = { models: { [config.launch.model]: { inputs: ['text', 'image'] } } };
  runtime.ownerId = owner; // 本夹具模拟当前管理员的专属运行时，产物验收使用其工作区。
  const agent = new AgentDefinition(root); agent.configure(config, runtime); agent.activate('studio-fixture');
  agent.availableSkills = agent.skills.map(skill => ({ ...skill, name: skill.id }));
  const rpc = new StudioCodex(), hub = new EventHub(), store = new TestJobs();
  const { hub: permissionHub, state: hubState } = hubFixture();
  hubState.users[0].id = owner; hubState.users[1].id = second;
  permissionHub.catalog = () => [{ type: 'agent', id: 'studio', scope: 'system', deploymentDefault: true },
    { type: 'tool_group', id: 'files', scope: 'system', tools: agent.definition.agent.tools.allow },
    ...agent.skills.map(skill => ({ type: 'skill', id: skill.id, scope: 'system' }))];
  const toolCalls = [];
  const gate = new PermissionGate({ scope: { ownerId: owner }, agent, permissionHub });
  rpc.on('notification', ({ method, params }) => {
    if (method === 'item/completed' && params.item.type === 'dynamicToolCall') toolCalls.push(params.item);
    if (method === 'turn/started') gate.started(params.threadId, params.turn.id);
    if (method === 'turn/completed') gate.end(params.threadId, params.turn.id);
  });
  const sessions = new SessionService({ rpc, config, runtime, hub, redact: createLogRedactor(fixture.CODEX_API_KEY) });
  const files = createFileTools(root, { workspaceDir: runtime.workspaceDir, sources: agent.sources, outputs: agent.outputs });
  const messages = await new MessageService({ rpc, config, sessions, hub, store, gate, permissionHub, files }).open();
  const session = await sessions.create();
  fs.mkdirSync(path.join(runtime.workspaceDir, 'inputs/drafts'), { recursive: true });
  for (const name of initialDrafts ? ['project.json', 'brief.json'] : []) fs.writeFileSync(path.join(runtime.workspaceDir, 'inputs/drafts', name), read(name));
  // design-check 服务在离线集成中返回固定布局报告，真实浏览器另由 layout-check.browser.mjs 验证。
  const design = createDesignTools({ files, env: { AGENT_NODE_ID: 'studio-fixture', AGENT_NODE_KEY: 'fixture-not-real' }, fetcher: async (_url, request) => {
    const { html } = JSON.parse(request.body);
    assert.ok(html.includes('design-outline'));
    return { status: 200, ok: true, json: async () => JSON.parse(read('qa/wireframe-v1-fixture-layout.json')) };
  } });
  cleanup(root, async () => { await messages.close(); sessions.close(); gate.close(); });
  const started = async n => {
    await until(() => rpc.calls.filter(call => call.method === 'turn/start').length === n);
    await until(() => store.state.jobs.find(job => job.workflow === 'design' && job.mode !== 'append').status === 'running');
    return rpc.calls.filter(call => call.method === 'turn/start').at(-1).params.input;
  };
  const produce = async (filesToWrite, expectedStep, expectedStatus = 'waiting', overrides = {}) => {
    const threadId = store.state.jobs.find(job => job.workflow === 'design' && job.mode !== 'append')?.threadId || session.id;
    const turnId = rpc.threads.get(threadId).turns.at(-1).id;
    let completed;
    const observe = event => {
      if (event.type !== 'queue' || event.threadId !== threadId) return;
      const job = event.data.jobs.find(job => job.workflow === 'design' && job.mode !== 'append' && job.turnId === turnId && job.status === expectedStatus);
      if (job) completed = structuredClone(job);
    };
    hub.on('event', observe);
    try {
      await gate.run(gate.forTurn(threadId, turnId), () => rpc.produce(threadId, filesToWrite, files, design, overrides));
      // 浏览器可能在 final 澄清到达后立刻继续；核对真实发布过的终态，不靠轮询碰巧看到等待窗口。
      await until(() => Boolean(completed));
      assert.equal(completed.step, expectedStep);
      assert.equal(completed.status, expectedStatus);
      assert.ok(completed.checks.every(c => c.passed));
    } finally { hub.off('event', observe); }
  };
  return { root, config, agent, runtime, files, rpc, store, messages, sessions, session, started, produce, permissionHub, hubState, toolCalls, hub, gate };
}
