import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defineWorkflows, describe, runChecks } from "../server/modules/workflows/index.mjs";
import { PermissionGate } from "../server/modules/permissions/index.mjs";
import { createTools as createTaskTools } from "../server/modules/tools/tasks.mjs";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { loadServerConfig, createLogRedactor } from "../server/modules/config/index.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { SessionService } from "../server/modules/sessions/index.mjs";
import { MessageService } from "../server/modules/messages/index.mjs";
import { EventHub } from "../server/modules/events/index.mjs";
import { TestJobs } from "./jobs-fixture.mjs";
import { FakeRpc, fixture, installToolFixture, tempRoot, cleanup, until } from "./helpers.mjs";

const base = { skills: [{ id: "outline", required: true }],
  knowledge: [{ kbId: "general", mode: "wiki", actions: ["read", "update"] }, { kbId: "docs", mode: "wiki", actions: ["read"] }] };
const report = { id: "report", label: "写报告", skill: "outline", checks: ["file-exists", "format", "sources-cited"] };

test("workflow 声明在启动时校验：未知内置、与内置同名、未声明 Skill、越权授权、授权参数非必填", () => {
  const cases = [
    [[{ id: "nope" }], /未知的内置/],
    [[{ id: "knowledge-maintain", label: "改写" }], /同名/],
    [[{ id: "report", skill: "missing" }], /未声明的 Skill/],
    [[{ id: "report", grants: [{ type: "knowledge.update", kbId: "docs" }] }], /没有该知识库的 update/],
    [[{ id: "report", params: { type: "object", additionalProperties: false, properties: { kb: { type: "string" } } },
      grants: [{ type: "knowledge.update", kbId: { param: "kb" } }] }], /未声明为必填/],
    [[{ id: "knowledge-maintain" }, { id: "knowledge-maintain" }], /重复/],
  ];
  for (const [workflows, pattern] of cases) assert.throws(() => defineWorkflows({ ...base, workflows }), pattern);
  assert.throws(() => defineWorkflows({ ...base, knowledge: [], workflows: [{ id: "knowledge-maintain" }] }), /没有挂载/);
  const ids = agent => agent.list().map(workflow => workflow.id);
  assert.deepEqual(ids(defineWorkflows(base)), ["chat", "knowledge-maintain"], "旧定义：有可更新的知识库就隐式启用知识维护");
  assert.deepEqual(ids(defineWorkflows({ ...base, knowledge: [base.knowledge[1]] })), ["chat"]);
  assert.deepEqual(ids(defineWorkflows({ ...base, workflows: [] })), ["chat"], "显式声明空数组就只剩 chat");
});

test("workflow 解析：参数按 schema 校验，授权落到具体知识库，结果不可修改", () => {
  const workflows = defineWorkflows({ ...base, workflows: [{ id: "knowledge-maintain" }, report] });
  const maintain = workflows.resolve("knowledge-maintain", { kbId: "general" });
  assert.deepEqual(maintain.grants, [{ type: "knowledge.update", kbId: "general" }]);
  assert.equal(maintain.skill, "knowledge");
  assert.ok(Object.isFrozen(maintain) && Object.isFrozen(maintain.grants[0]));
  for (const [id, params, status] of [["knowledge-maintain", { kbId: "docs" }, 403], ["knowledge-maintain", {}, 400],
    ["knowledge-maintain", { kbId: "general", extra: "x" }, 400], ["knowledge-maintain", ["general"], 400],
    ["missing", null, 403], ["chat", { x: "1" }, 400]]) {
    assert.throws(() => workflows.resolve(id, params), error => error.status === status, `${id} ${JSON.stringify(params)}`);
  }
  assert.deepEqual({ ...workflows.resolve("report") }, { id: "report", label: "写报告", skill: "outline", params: null, grants: [], checks: report.checks, steps: null });
  assert.equal(workflows.resolve().id, "chat");
});

test("任务说明只写目标、授权和验收；验收只看产物和生效的修订", t => {
  const workflows = defineWorkflows({ ...base, workflows: [{ id: "knowledge-maintain" }] });
  assert.equal(describe(workflows.resolve("chat")), null);
  const brief = describe(workflows.resolve("knowledge-maintain", { kbId: "general" }));
  assert.match(brief, /知识库维护（knowledge-maintain）/);
  assert.match(brief, /可以更新知识库 general/);
  assert.match(brief, /Wiki 修订已生效/);
  const workspaceDir = tempRoot(t);
  fs.mkdirSync(path.join(workspaceDir, "outputs"));
  fs.writeFileSync(path.join(workspaceDir, "outputs/a.md"), "正文");
  const check = (artifacts, revisions = {}) => Object.fromEntries(runChecks(["file-exists", "format", "sources-cited", "wiki-effective"],
    { artifacts, revisions }, { workspaceDir, formats: ["md", "txt"] }).map(result => [result.id, result.passed]));
  assert.deepEqual(check({ w: { locator: "outputs/a.md", format: "md", sources: 2 } }, { k: { kbId: "general", slug: "p", effective: true } }),
    { "file-exists": true, format: true, "sources-cited": true, "wiki-effective": true });
  assert.deepEqual(check({ w: { locator: "outputs/missing.md", format: "pdf", sources: 0 } }),
    { "file-exists": false, format: false, "sources-cited": false, "wiki-effective": false });
  assert.deepEqual(check({}), { "file-exists": false, format: false, "sources-cited": false, "wiki-effective": false }, "没有产物不能算通过");
});

async function messageRig(t, workflows, gate) {
  const root = installToolFixture(tempRoot(t), { knowledge: true });
  fs.mkdirSync(path.join(root, "agents/writing/skills/outline"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents/writing/skills/outline/SKILL.md"), "---\nname: outline\n---\n提纲方法\n");
  const file = path.join(root, "agents/writing/agent.json"), definition = JSON.parse(fs.readFileSync(file));
  definition.agent.skills.push({ id: "outline", required: true });
  definition.bindings.skills.outline = { path: "skills/outline/SKILL.md" };
  definition.agent.workflows = workflows;
  fs.writeFileSync(file, JSON.stringify(definition));
  const config = loadServerConfig(root, fixture);
  const runtime = await prepareRun(config.launch, root);
  const agent = new AgentDefinition(root); agent.configure(config, runtime); agent.activate("unit-tools");
  // 模拟 verifySkills 的结果：两个 Skill 都已被 Codex 发现并启用。
  agent.availableSkills = agent.skills.map(skill => ({ ...skill, name: skill.id }));
  const rpc = new FakeRpc(), hub = new EventHub(), store = new TestJobs();
  const sessions = new SessionService({ rpc, config, runtime, hub, redact: createLogRedactor(fixture.CODEX_API_KEY) });
  const messages = await new MessageService({ rpc, config, sessions, hub, store, gate }).open();
  const session = await sessions.create();
  cleanup(root, async () => { await messages.close(); sessions.close(); });
  const submit = (id, fields = {}) => messages.submit({ threadId: session.id, clientMessageId: id, text: `正文 ${id}`, ...fields });
  const started = async count => { await until(() => rpc.calls.filter(call => call.method === "turn/start").length >= count); return rpc.calls.filter(call => call.method === "turn/start")[count - 1].params.input; };
  return { root, rpc, store, messages, session, submit, started };
}

test("按 workflow 入队与派发：注入任务说明和 Skill，旧 knowledge 字段等价于知识维护，追加不能换 workflow", async t => {
  const r = await messageRig(t, [{ id: "knowledge-maintain" }, report]);
  const job = await r.submit("m1", { workflow: "knowledge-maintain", params: { kbId: "general" } });
  assert.equal(job.workflow, "knowledge-maintain");
  assert.deepEqual(job.params, { kbId: "general" });
  const input = await r.started(1);
  assert.match(input[0].text, /【工作流】知识库维护/);
  assert.equal(input[1].text, "正文 m1", "用户原文不被改写");
  assert.deepEqual(input.filter(item => item.type === "skill").map(item => item.name), ["knowledge"]);
  r.rpc.finish(r.session.id);
  await until(() => !["queued", "starting", "running"].includes(r.store.get("m1").status));
  assert.equal(r.store.get("m1").status, "needs-review", "知识维护没有生效的修订，验收不通过");
  assert.equal(r.store.paused(r.session.id), false, "验收不通过不暂停队列");
  const legacy = await r.submit("m2", { knowledge: { kbId: "general", operation: "update" } });
  assert.equal(legacy.workflow, "knowledge-maintain");
  assert.deepEqual(legacy.params, { kbId: "general" });
  for (const [index, [fields, status]] of [[{ knowledge: { kbId: "general", operation: "update" }, workflow: "chat" }, 400],
    [{ knowledge: { kbId: "general" } }, 400], [{ workflow: "missing" }, 403], [{ workflow: "knowledge-maintain", params: { kbId: "docs" } }, 403],
    [{ workflow: 1 }, 400], [{ workflow: "report", mode: "append", targetTurnId: "turn-1" }, 403]].entries())
    await assert.rejects(r.submit(`bad-${index}`, fields), error => error.status === status, JSON.stringify(fields));
  await assert.rejects(r.submit("m2", { workflow: "report" }), error => error.status === 409, "同一个消息 ID 不能换 workflow");
  const chat = await r.submit("m3");
  assert.equal(chat.workflow, "chat");
  await r.started(2);
  r.rpc.finish(r.session.id);
  const plain = await r.started(3);
  assert.deepEqual(plain.map(item => item.type), ["text"], "普通对话没有任务说明，也不注入 Skill");
});

test("验收：没有产物记为 needs-review 并附结果；带来源版本的产物通过", async t => {
  const r = await messageRig(t, [report]);
  await r.submit("r1", { workflow: "report" });
  await r.started(1);
  r.rpc.finish(r.session.id);
  await until(() => r.store.get("r1").status === "needs-review");
  assert.deepEqual(r.store.get("r1").checks.map(check => check.passed), [false, false, false]);
  await r.submit("r2", { workflow: "report" });
  await r.started(2);
  fs.writeFileSync(path.join(r.root, "workspace/outputs/report.md"), "报告");
  const turn = r.rpc.threads.get(r.session.id).turns.at(-1);
  r.rpc.notify("item/completed", { threadId: r.session.id, turnId: turn.id, item: { type: "dynamicToolCall", id: "w1", tool: "write_file",
    status: "completed", success: true, arguments: { path: "outputs/report.md", content: "报告", source_versions: [{ resourceId: "r", versionId: "v" }] },
    contentItems: [{ type: "inputText", text: JSON.stringify({ created: true, artifact: { locator: "outputs/report.md", format: "md" } }) }] } });
  r.rpc.finish(r.session.id);
  await until(() => r.store.get("r2").status === "completed");
  assert.ok(r.store.get("r2").checks.every(check => check.passed), JSON.stringify(r.store.get("r2").checks));
});

test("workflows 需要 schemaVersion 1.2；参数 schema 只允许扁平字符串字段", t => {
  const root = installToolFixture(tempRoot(t), { knowledge: true });
  const file = path.join(root, "agents/writing/agent.json"), original = fs.readFileSync(file, "utf8");
  const edit = change => { const value = JSON.parse(original); change(value); fs.writeFileSync(file, JSON.stringify(value)); };
  edit(v => { v.schemaVersion = "1.1"; });
  assert.throws(() => new AgentDefinition(root), /需要 schemaVersion 1.2/);
  edit(v => { v.agent.workflows.push({ id: "nested", params: { type: "object", additionalProperties: false, properties: { a: { type: "object" } } } }); });
  assert.throws(() => new AgentDefinition(root), /Agent 定义无效/);
  edit(v => { v.agent.workflows.push({ id: "bad-check", checks: ["model-says-done"] }); });
  assert.throws(() => new AgentDefinition(root), /Agent 定义无效/);
});

const article = { id: "article", label: "写文章", skill: "outline", steps: [
  { id: "outline", goal: "确定立意与大纲，保存到 drafts/", writes: ["drafts"], confirm: true },
  { id: "final", goal: "完成研究、写作与核查并定稿", writes: ["research", "drafts", "outputs"], checks: ["file-exists", "format"] }] };

test("步骤声明：最后一步不能要求确认，写入范围不能超出基础权限，有 steps 时 checks 写在步骤上", () => {
  const writable = ["research", "drafts", "outputs"];
  const define = workflow => defineWorkflows({ ...base, workflows: [workflow] }, { writable });
  assert.throws(() => define({ ...article, steps: [article.steps[0], { ...article.steps[1], confirm: true }] }), /最后一步不需要确认/);
  assert.throws(() => define({ ...article, steps: [{ ...article.steps[0], writes: ["inputs"] }, article.steps[1]] }), /超出 Agent 可新建文件的范围/);
  assert.throws(() => define({ ...article, checks: ["format"] }), /checks 写在步骤上/);
  assert.throws(() => define({ ...article, steps: [article.steps[0], { ...article.steps[1], id: "outline" }] }), /步骤 id 重复/);
  const resolved = define({ ...article, steps: [{ ...article.steps[0], writes: ["drafts/outlines"] }, article.steps[1]] }).resolve("article");
  assert.deepEqual(resolved.steps.map(step => [step.id, step.confirm, step.writes]), [["outline", true, ["drafts/outlines"]], ["final", false, ["research", "drafts", "outputs"]]]);
  const first = describe(resolved, 0), last = describe(resolved, 1);
  assert.match(first, /第 1\/2 步：outline/);
  assert.match(first, /只能在这些位置新建文件：drafts\/outlines/);
  assert.match(first, /等待用户确认/);
  assert.match(last, /第 2\/2 步：final/);
  assert.match(last, /产物文件存在、产物格式合规/);
  assert.doesNotMatch(last, /等待用户确认/);
});

test("权限门：步骤的 writes 只收窄新建文件的位置，不影响读取", async () => {
  const agent = { assertCurrent() {}, allowsTool: () => true, outputs: { directory: "outputs" },
    sources: [{ locator: "drafts", actions: ["read", "create"] }, { locator: "research", actions: ["read", "create"] }],
    definition: { agent: { id: "a" }, bindings: {} } };
  const gate = new PermissionGate({ scope: { ownerId: "owner" }, agent });
  gate.start({ id: "task", threadId: "t" }, [], ["drafts"]); gate.started("t", "turn");
  await gate.run(gate.forTurn("t", "turn"), async () => {
    gate.check("create", { path: "drafts/outline.md" });
    gate.check("read", { path: "research/notes.md" });
    assert.throws(() => gate.check("create", { path: "outputs/article.md" }), /未授权/);
    assert.throws(() => gate.check("create", { path: "research/notes.md" }), /未授权/);
  });
  gate.end("t", "turn"); gate.start({ id: "chat", threadId: "t" }); gate.started("t", "turn-2");
  await gate.run(gate.forTurn("t", "turn-2"), async () => gate.check("create", { path: "outputs/article.md" }));
});

test("多步 workflow：确认点停在 waiting，期间可以普通对话；确认带补充说明进入下一步；可以结束等待的任务", async t => {
  const starts = [];
  const gate = { submission: () => null, run: (principal, operation) => operation(), authorize: grants => grants, end() {},
    start: (job, grants, writes) => starts.push({ id: job.id, writes }) };
  const r = await messageRig(t, [article], gate);
  await r.submit("a1", { workflow: "article" });
  const first = await r.started(1);
  assert.match(first[0].text, /第 1\/2 步：outline/);
  assert.equal(first[1].text, "正文 a1");
  assert.deepEqual(starts.at(-1), { id: "a1", writes: ["drafts"] });
  r.rpc.finish(r.session.id);
  await until(() => r.store.get("a1").status === "waiting");
  assert.equal(r.store.get("a1").step, 0);
  assert.deepEqual(r.messages.publicJob(r.store.get("a1")), { ...r.store.get("a1"), text: "正文 a1", stepId: "outline", steps: 2 });
  await r.submit("chat-1");
  await r.started(2);
  r.rpc.finish(r.session.id);
  await until(() => r.store.get("chat-1").status === "completed");
  assert.equal(r.store.get("a1").status, "waiting", "等待确认时，普通对话照常执行，不会推进 workflow");
  await assert.rejects(r.messages.confirm({ threadId: r.session.id, taskId: "chat-1" }), error => error.status === 409);
  const confirmed = await r.messages.confirm({ threadId: r.session.id, taskId: "a1", text: "按第二版大纲写" });
  assert.equal(confirmed.step, 1);
  const second = await r.started(3);
  assert.match(second[0].text, /第 2\/2 步：final/);
  assert.equal(second[1].text, "用户已确认上一步，请继续。\n用户补充：按第二版大纲写");
  assert.deepEqual(starts.at(-1), { id: "a1", writes: ["research", "drafts", "outputs"] });
  r.rpc.finish(r.session.id);
  await until(() => r.store.get("a1").status === "needs-review");
  assert.deepEqual(r.store.get("a1").checks.map(check => check.id), ["file-exists", "format"], "只运行最后一步自己的验收");
  await r.submit("a2", { workflow: "article" });
  await r.started(4);
  r.rpc.finish(r.session.id);
  await until(() => r.store.get("a2").status === "waiting");
  assert.equal((await r.messages.cancel({ threadId: r.session.id, taskId: "a2" })).status, "cancelled");
  await assert.rejects(r.messages.confirm({ threadId: r.session.id, taskId: "a2" }), error => error.status === 409);
  await assert.rejects(r.messages.confirm({ threadId: r.session.id, taskId: "a2", extra: 1 }), error => error.status === 400);
});

test("提议任务：只记录为 proposed，不排队、不授权；用户确认时在用户身份下授权，补充说明进入输入；可以忽略；有上限", async t => {
  const authorized = [];
  const gate = { submission: () => null, run: (principal, operation) => operation(), end() {}, start() {},
    authorize: grants => { authorized.push(grants); return grants; } };
  const r = await messageRig(t, [{ id: "knowledge-maintain" }, report], gate);
  const context = { threadId: r.session.id, userId: undefined };
  const proposed = await r.messages.propose(context, { workflow: "knowledge-maintain", params: { kbId: "general" }, text: "把新资料整理进 Wiki", reason: "用户要求更新知识库，普通对话没有维护权限" });
  assert.equal(proposed.status, "proposed");
  const job = r.store.get(proposed.taskId);
  assert.deepEqual([job.status, job.workflow, job.params, job.reason], ["proposed", "knowledge-maintain", { kbId: "general" }, "用户要求更新知识库，普通对话没有维护权限"]);
  assert.deepEqual(authorized, [], "提议时不授权");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 0, "提议不会自动执行");
  for (const [args, status] of [[{ workflow: "chat", text: "x", reason: "y" }, 400], [{ workflow: "missing", text: "x", reason: "y" }, 403],
    [{ workflow: "knowledge-maintain", params: { kbId: "docs" }, text: "x", reason: "y" }, 403], [{ workflow: "report", text: "x" }, 400],
    [{ workflow: "report", text: "x", reason: "y", status: "queued" }, 400]])
    await assert.rejects(r.messages.propose(context, args), error => error.status === status, JSON.stringify(args));
  await r.messages.confirm({ threadId: r.session.id, taskId: proposed.taskId, text: "只整理 inputs/general/new.md" });
  assert.deepEqual(authorized, [[{ type: "knowledge.update", kbId: "general" }]], "确认时在用户身份下核对授权");
  const input = await r.started(1);
  assert.match(input[0].text, /【工作流】知识库维护/);
  assert.equal(input[1].text, "把新资料整理进 Wiki\n用户补充：只整理 inputs/general/new.md");
  r.rpc.finish(r.session.id);
  const ignored = await r.messages.propose(context, { workflow: "report", text: "写周报", reason: "用户提到要汇报" });
  assert.equal((await r.messages.cancel({ threadId: r.session.id, taskId: ignored.taskId })).status, "cancelled");
  for (let i = 0; i < 3; i++) await r.messages.propose(context, { workflow: "report", text: `报告 ${i}`, reason: "测试上限" });
  await assert.rejects(r.messages.propose(context, { workflow: "report", text: "再来", reason: "测试上限" }), error => error.status === 429);
  await assert.rejects(createTaskTools({ tasks: r.messages }).propose_task({ workflow: "report", text: "x", reason: "y" }, {}), /会话身份/,
    "没有权限门提供的会话身份时不能提议");
});

test("资源规则列出可提议的 workflow；没有允许 propose_task 时不提示提议", t => {
  const root = installToolFixture(tempRoot(t), { knowledge: true, article: true });
  const file = path.join(root, "agents/writing/agent.json"), original = fs.readFileSync(file, "utf8");
  const agent = new AgentDefinition(root);
  assert.match(agent.instructions, /"workflows":\[\{"id":"knowledge-maintain","label":"知识库维护","params":\["kbId"\],"steps":1\},\{"id":"write-article","label":"写文章","params":\[\],"steps":2\}\]/);
  assert.match(agent.instructions, /用 propose_task 向用户提议/);
  const value = JSON.parse(original); value.agent.tools.allow = value.agent.tools.allow.filter(name => name !== "propose_task");
  fs.writeFileSync(file, JSON.stringify(value));
  assert.doesNotMatch(new AgentDefinition(root).instructions, /propose_task/);
});
