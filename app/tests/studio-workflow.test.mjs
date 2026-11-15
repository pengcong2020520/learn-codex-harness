import test from 'node:test';
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
class StudioCodex extends FakeRpc {
  async produce(threadId, files, toolFiles, design) {
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

async function rig(t) {
  const root = installToolFixture(tempRoot(t));
  fs.copyFileSync(path.join(import.meta.dirname, '../config/models.json'), path.join(root, 'config/models.json'));
  fs.writeFileSync(path.join(root, 'config/runtime/project.json'), JSON.stringify({ agentDefinition: 'agents/studio/agent.json' }));
  const config = loadServerConfig(root, fixture), runtime = await prepareRun(config.launch, root);
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
  const messages = await new MessageService({ rpc, config, sessions, hub, store, gate, permissionHub }).open();
  const session = await sessions.create();
  const files = createFileTools(root, { workspaceDir: runtime.workspaceDir, sources: agent.sources, outputs: agent.outputs });
  fs.mkdirSync(path.join(runtime.workspaceDir, 'inputs/drafts'), { recursive: true });
  for (const name of ['project.json', 'brief.json']) fs.writeFileSync(path.join(runtime.workspaceDir, 'inputs/drafts', name), read(name));
  // design-check 服务在离线集成中返回固定布局报告，真实浏览器另由 layout-check.browser.mjs 验证。
  const design = createDesignTools({ files, env: { AGENT_NODE_ID: 'studio-fixture', AGENT_NODE_KEY: 'fixture-not-real' }, fetcher: async (_url, request) => {
    const { html } = JSON.parse(request.body);
    assert.ok(html.includes('design-outline'));
    return { status: 200, ok: true, json: async () => JSON.parse(read('qa/wireframe-v1-fixture-layout.json')) };
  } });
  cleanup(root, async () => { await messages.close(); sessions.close(); gate.close(); });
  const started = async n => {
    await until(() => rpc.calls.filter(call => call.method === 'turn/start').length === n);
    await until(() => store.get('design-task').status === 'running');
    return rpc.calls.filter(call => call.method === 'turn/start').at(-1).params.input;
  };
  const produce = async (filesToWrite, expectedStep, expectedStatus = 'waiting') => {
    const turnId = rpc.threads.get(session.id).turns.at(-1).id;
    await gate.run(gate.forTurn(session.id, turnId), () => rpc.produce(session.id, filesToWrite, files, design));
    await until(() => store.get('design-task').status === expectedStatus);
    assert.equal(store.get('design-task').step, expectedStep);
    assert.ok(store.get('design-task').checks.every(c => c.passed));
  };
  return { root, config, agent, runtime, files, rpc, store, messages, sessions, session, started, produce, permissionHub, hubState, toolCalls };
}

test('工作室 design：管理员完整六步、澄清 revise 两轮、原型 revise、运行中 steer、确认点和单占用', async t => admin(async () => {
  const r = await rig(t);
  return r.permissionHub.withUser(owner, async () => {
  const submit = (id, threadId = r.session.id) => r.messages.submit({ threadId, clientMessageId: id, text: '按资料卡设计事项整理助手', workflow: 'design' });
  const { accounts } = await accountFixture();
  const http = httpFixture(accounts, { config: r.config, sessions: r.sessions, messages: r.messages, permissionHub: r.permissionHub });
  t.after(() => http.close());
  const token = (await accounts.login({ username: 'bob', password: 'fixture-password' }, 'fixture')).token;
  assert.equal((await request(http, '/messages', { token, body: { threadId: r.session.id, clientMessageId: 'user-http', text: '启动设计', workflow: 'design' } })).statusCode, 403);
  await runIdentity({ userId: second, role: 'admin' }, () => r.permissionHub.withUser(second, () => assert.rejects(submit('denied'), { status: 403 })));
  r.hubState.users[1].role = 'admin';
  await submit('design-task');
  assert.match((await r.started(1))[0].text, /第 1\/6 步：clarify/);
  assert.deepEqual(await r.messages.feedback({ taskId: 'design-task', text: '保持只管理个人事项', context: { screen: '资料卡', state: 'default' } }), { mode: 'steer' });
  await until(() => r.rpc.calls.some(call => call.method === 'turn/steer'));
  const steering = r.rpc.calls.find(call => call.method === 'turn/steer');
  assert.ok(steering.params.input.some(item => item.text?.includes('保持只管理个人事项')));
  await r.produce(['clarify-r1.json'], 0);
  await runIdentity({ userId: second, role: 'admin' }, () => r.permissionHub.withUser(second, async () => {
    const other = await r.sessions.create();
    await assert.rejects(submit('occupied', other.id), error => error.status === 409 && error.code === 'WORKFLOW_OCCUPIED');
  }));
  for (const [round, answer] of [[2, '我确认后保存'], [3, '仅本人可见']]) {
    const draft = { round: round - 1, answers: [{ id: `q${round - 1}`, text: answer }] };
    r.files.write_draft({ name: 'clarify.json', content: Buffer.from(JSON.stringify(draft)) });
    const text = `提交第 ${round - 1} 轮澄清答案`;
    assert.deepEqual(await r.messages.feedback({ taskId: 'design-task', text }), { mode: 'revise' });
    assert.ok((await r.started(round)).some(item => item.text?.includes(text)));
    assert.deepEqual(JSON.parse(r.files.read_draft({ name: 'clarify.json' }).content), draft);
    await r.produce([`clarify-r${round}.json`, ...(round === 3 ? ['brief-v1.md', 'decisions-v1.json'] : [])], 0);
    assert.equal(r.store.get('design-task').reviseCount, round - 1);
  }
  assert.equal(JSON.parse(r.files.read_file({ path: prefix + 'clarify-r3.json' }).content).final, true);
  const stages = [
    ['prd', ['prd-v1.md', 'decisions-v2.json']],
    ['lofi', ['wireframe-v1.html', 'qa/lofi-review-v1.json', 'decisions-v3.json']],
    ['theme', ['theme-sample-v1.html', 'theme-sample-v2.html', 'theme-sample-v3.html', 'themes-r1.json', 'decisions-v4.json']],
    ['hifi', ['theme-v1.json', 'prototype-v1.html', 'structure-changes-v1.json', 'qa/hifi-review-v1.json', 'decisions-v5.json']],
  ];
  for (const [i, [step, files]] of stages.entries()) {
    if (step === 'hifi') {
      assert.equal(fs.existsSync(path.join(r.runtime.workspaceDir, prefix, 'theme-v1.json')), false, 'theme 确认点只产出候选');
      r.files.write_draft({ name: 'theme.json', content: Buffer.from(read('theme.json')) });
    }
    await r.messages.confirm({ taskId: 'design-task', threadId: r.session.id });
    const input = await r.started(i + 4); assert.ok(input[0].text.includes(`步：${step}`));
    await r.produce(files, i + 1);
    if (step === 'hifi') {
      const selected = JSON.parse(r.files.read_file({ path: prefix + 'theme-v1.json' }).content);
      assert.equal(selected.source.styleId, JSON.parse(read('theme.json')).styleId);
      assert.equal(selected.source.themeId, JSON.parse(read('theme.json')).themeId);
      assert.match(input[0].text, /首先读取 inputs\/drafts\/theme\.json/);
      const actions = r.toolCalls.map(call => `${call.tool}:${call.arguments.path}`);
      const draftRead = actions.indexOf('read_file:inputs/drafts/theme.json');
      const themeWrite = actions.indexOf(`write_file:${prefix}theme-v1.json`);
      const prototypeWrite = actions.indexOf(`write_file:${prefix}prototype-v1.html`);
      assert.ok(draftRead >= 0 && draftRead < themeWrite && themeWrite < prototypeWrite, 'hifi 先读选择草稿、保存 theme-v，再写原型');
      assert.equal(actions.filter(action => action.startsWith(`check_design:${prefix}theme-sample-`)).length, 3, '已有通过的组合直接引用，不重复检查');
      assert.deepEqual(selected.designReport, r.rpc.designReports.get(selected.source.sample));
    }
    assert.equal(r.rpc.calls.filter(c => c.method === 'turn/start').length, i + 4, '等待时不能自动进入下一步');
  }
  const first = r.files.read_file({ path: prefix + 'prototype-v1.html' }).revision;
  assert.deepEqual(await r.messages.feedback({ taskId: 'design-task', text: read('feedback.md'), context: { screen: 'web-review', state: 'default' } }), { mode: 'revise' });
  await r.started(8);
  await r.produce(['prototype-v2.html', 'qa/hifi-review-v2.json', 'decisions-v6.json'], 4);
  assert.equal(r.files.read_file({ path: prefix + 'prototype-v1.html' }).revision, first, '修订不能覆写历史');
  assert.notEqual(r.files.read_file({ path: prefix + 'prototype-v2.html' }).revision, first);
  const decisions = JSON.parse(r.files.read_file({ path: prefix + 'decisions-v6.json' }).content);
  for (const text of ['保持只管理个人事项', '提交第 1 轮澄清答案', '提交第 2 轮澄清答案', read('feedback.md')]) {
    assert.ok(decisions.events.some(event => event.feedback === text), 'decisions 保留反馈原话，包括换行');
  }
  await r.messages.confirm({ taskId: 'design-task', threadId: r.session.id });
  assert.match((await r.started(9))[0].text, /第 6\/6 步：package/);
  await r.produce(children(path.join(fixtures, 'package-v1')).map(file => `package-v1/${file}`), 5, 'completed');
  assert.equal(r.store.workflowOccupancy('design'), null);
  const report = JSON.parse(r.files.read_file({ path: prefix + 'qa/package-check.json' }).content);
  assert.equal(report.ok, true); assert.equal(report.errors, 0);
  assert.deepEqual(r.rpc.calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text.match(/步：(\w+)/)[1]), ['clarify', 'clarify', 'clarify', 'prd', 'lofi', 'theme', 'hifi', 'hifi', 'package']);
  });
}));


test('hifi 未检查组合：先检查默认组合样页，再写唯一 theme-v 和原型', async t => admin(async () => {
  const r = await rig(t);
  await r.permissionHub.withUser(owner, async () => {
    await r.messages.submit({ threadId: r.session.id, clientMessageId: 'design-task', text: '按资料卡设计事项整理助手', workflow: 'design' });
    await r.started(1); await r.produce(['clarify-final-r1.json', 'brief-v1.md'], 0);
    const stages = [['prd-v1.md'], ['wireframe-v1.html', 'qa/lofi-review-v1.json'],
      ['theme-sample-v1.html', 'theme-sample-v2.html', 'theme-sample-v3.html', 'themes-r1.json']];
    for (const [i, files] of stages.entries()) {
      await r.messages.confirm({ taskId: 'design-task', threadId: r.session.id });
      await r.started(i + 2); await r.produce(files, i + 1);
    }
    const candidates = JSON.parse(read('themes-r1.json'));
    const draft = { styleId: candidates.styles[1].id, themeId: candidates.themes[0].id, round: 1 };
    assert.equal(candidates.samples.some(item => item.styleId === draft.styleId && item.themeId === draft.themeId), false);
    r.files.write_draft({ name: 'theme.json', content: Buffer.from(JSON.stringify(draft)) });
    const start = r.toolCalls.length;
    await r.messages.confirm({ taskId: 'design-task', threadId: r.session.id });
    await r.started(5); await r.produce(['theme-v1.json', 'prototype-v1.html'], 4);
    const calls = r.toolCalls.slice(start);
    const actions = calls.map(call => `${call.tool}:${call.arguments.path}`);
    const sequence = ['read_file:inputs/drafts/theme.json', `write_file:${prefix}theme-sample-v4.html`,
      `check_design:${prefix}theme-sample-v4.html`, `write_file:${prefix}theme-v1.json`, `write_file:${prefix}prototype-v1.html`].map(action => actions.indexOf(action));
    assert.ok(sequence.every((position, i) => position >= 0 && (i === 0 || position > sequence[i - 1])), '草稿 → 新样页 → 检查 → 唯一主题文件 → 原型');
    assert.equal(calls.filter(call => call.tool === 'write_file' && /\/theme-v\d+\.json$/.test(call.arguments.path)).length, 1);
    const selected = JSON.parse(r.files.read_file({ path: prefix + 'theme-v1.json' }).content);
    assert.equal(selected.source.sample, 'theme-sample-v4.html');
    assert.equal(selected.source.styleId, draft.styleId); assert.equal(selected.source.themeId, draft.themeId);
    assert.deepEqual(selected.style, candidates.styles[1].tokens); assert.deepEqual(selected.theme, candidates.themes[0].tokens);
    const checked = calls.find(call => call.tool === 'check_design' && call.arguments.path === prefix + selected.source.sample);
    const result = JSON.parse(checked.contentItems[0].text);
    assert.deepEqual(selected.designReport, { artifact: selected.source.sample, reportPath: result.reportPath.slice(prefix.length),
      status: 'completed', errors: 0, warnings: result.warnings });
    const reportRead = actions.indexOf(`read_file:${result.reportPath}`);
    assert.ok(sequence[2] < reportRead && reportRead < sequence[3], '检查后、写主题前读取完整报告');
    const report = JSON.parse(r.files.read_file({ path: result.reportPath }).content);
    assert.equal(report.file, prefix + selected.source.sample);
    const html = r.files.read_file({ path: prefix + selected.source.sample }).content;
    assert.deepEqual(JSON.parse(html.match(/const baseTokens=(.*);\n/)[1]), { style: selected.style, theme: selected.theme });
    const css = html.match(/:root\{([^}]*)\}/)[1];
    for (const [key, value] of Object.entries({ ...selected.style, ...selected.theme })) assert.ok(css.includes(`${key}:${value};`));
  });
}));

test('主题换一换与结构决定：先写结构化草稿，再用固定文字触发本步 revise', async t => {
  for (const target of ['theme', 'hifi']) await t.test(target, async t => admin(async () => {
    const r = await rig(t);
    await r.permissionHub.withUser(owner, async () => {
      await r.messages.submit({ threadId: r.session.id, clientMessageId: 'design-task', text: '按资料卡设计事项整理助手', workflow: 'design' });
      await r.started(1);
      await r.produce(['clarify-final-r1.json', 'brief-v1.md'], 0);
      const stages = [
        ['prd-v1.md'], ['wireframe-v1.html', 'qa/lofi-review-v1.json'],
        ['themes-r1.json', 'theme-sample-v1.html', 'theme-sample-v2.html', 'theme-sample-v3.html'],
        ['theme-v1.json', 'prototype-v1.html', 'prototype-v2.html', 'structure-changes-proposed-v2.json', 'qa/hifi-review-v2.json'],
      ];
      const last = target === 'theme' ? 3 : 4;
      for (let step = 1; step <= last; step++) {
        if (step === 4) r.files.write_draft({ name: 'theme.json', content: Buffer.from(read('theme.json')) });
        await r.messages.confirm({ taskId: 'design-task', threadId: r.session.id });
        await r.started(step + 1); await r.produce(stages[step - 1], step);
      }
      const name = target === 'theme' ? 'theme.json' : 'structure-changes.json';
      r.files.write_draft({ name, content: Buffer.from(read(name)) });
      const text = target === 'theme' ? '换一换：风格' : '按结构改动决定生成';
      assert.deepEqual(await r.messages.feedback({ taskId: 'design-task', text }), { mode: 'revise' });
      const input = await r.started(last + 2);
      assert.ok(input.some(item => item.text?.includes(text)));
      assert.ok(input[0].text.includes(`步：${target}`));
      assert.deepEqual(JSON.parse(r.files.read_draft({ name }).content), JSON.parse(read(name)));
      assert.equal(r.store.get('design-task').step, last);
      // 本例只验证前端草稿与 revise 调度；不把固定响应冒充模型完成了候选替换或结构修改。
    });
  }));
});
