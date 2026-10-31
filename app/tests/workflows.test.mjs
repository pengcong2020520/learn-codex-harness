import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defineWorkflows, describe, runChecks } from "../server/modules/workflows/index.mjs";
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
  assert.deepEqual({ ...workflows.resolve("report") }, { id: "report", label: "写报告", skill: "outline", params: null, grants: [], checks: report.checks });
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

async function messageRig(t, workflows) {
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
  const messages = await new MessageService({ rpc, config, sessions, hub, store }).open();
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
