import { testDataFactory } from './jobs-fixture.mjs';
// 真 Codex 0.154.0 + 本机模拟 Responses，不读取 .env，不使用真实模型密钥。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startAgentServer } from "../server/main.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { RunMaintenance, RUN_RETENTION } from "../server/modules/maintenance/index.mjs";
import { tempRoot, cleanup, until, installToolFixture } from "./helpers.mjs";
import { responsesFixture, answer, toolCall, toolSpecs } from "./responses-fixture.mjs";

function definition(root, change) {
  const file = path.join(root, "agents/writing/agent.json");
  const value = JSON.parse(fs.readFileSync(file)); change(value);
  fs.writeFileSync(file, JSON.stringify(value));
}
function configFor(root, provider) {
  const config = loadServerConfig(root, { CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: provider.url,
    CODEX_MODEL: "local-test-model", CODEX_MODEL_CATALOG_ENABLED: "true",
    CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "15000" });
  config.port = 0; return config;
}
async function done(app, id) {
  await until(() => ["completed", "failed", "unconfirmed", "interrupted"].includes(app.messages.job(id)?.status), 15000);
  assert.equal(app.messages.job(id).status, "completed", app.messages.job(id).error);
}

test("真实 Codex：角色装配、受限 MCP 文件闭环、稳定 cwd、重启恢复与清理", { timeout: 60000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  definition(root, v => v.agent.tools.allow = ["list_files", "read_file", "write_file"]);
  fs.appendFileSync(path.join(root, "agents/writing/role.md"), "\nROLE_ASSEMBLY_FIXTURE\n");
  let step = 0;
  const provider = await responsesFixture(root, body => {
    const specs = toolSpecs(body), names = specs.map(tool => tool.name);
    assert.ok(JSON.stringify(body).includes("ROLE_ASSEMBLY_FIXTURE"), "角色没有进入原生模型请求");
    assert.ok(!names.some(name => /exec_command|shell_command|apply_patch|search_web|read_webpage/.test(name || "")));
    const plan = [
      ["write_file", { path: "outputs/article.md", content: "文章：测试观点与证据。" }],
      ["read_file", { path: "outputs/article.md" }], null,
      ["read_file", { path: "outputs/article.md" }], null
    ];
    const action = plan[step++];
    if (!action) return answer("文章已生成，测试闭环完成。");
    const spec = specs.find(item => item.name?.endsWith(action[0]));
    assert.ok(spec, "没有发现允许的 MCP 工具");
    return toolCall(spec, action[1]);
  });
  let app;
  cleanup(root, () => app?.close());
  app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  const session = await app.sessions.create(), other = await app.sessions.create();
  assert.notEqual(session.id, other.id);
  assert.equal(app.sessions.sessions.get(session.id).cwd, app.runtime.workspaceDir);
  assert.equal(app.sessions.sessions.get(other.id).cwd, app.runtime.workspaceDir);
  assert.notEqual(app.runtime.runDir, app.runtime.workspaceDir);
  await app.messages.submit({ threadId: session.id, clientMessageId: "first", text: "请保存并读取文章。" });
  await done(app, "first");
  assert.deepEqual(provider.errors, []);
  assert.equal(fs.readFileSync(path.join(root, "workspace/outputs/article.md"), "utf8"), "文章：测试观点与证据。");
  const turn = app.sessions.snapshot(session.id).turns.at(-1);
  assert.equal(Object.keys(turn.tools).length, 2);
  assert.equal(Object.keys(turn.artifacts).length, 1, "可信工具写入事件应关联到原生 turn");
  assert.equal((await app.tools.registry.call({ tool: "search_web", arguments: { query: "bypass" } })).success, false);
  const oldRun = app.runtime.runDir, workspaceDir = app.runtime.workspaceDir;
  const descriptor = app.agent.descriptor.hash;
  await app.close();
  app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  assert.equal(app.agent.descriptor.hash, descriptor);
  assert.equal(app.runtime.workspaceDir, workspaceDir);
  assert.notEqual(app.runtime.runDir, oldRun);
  const maintenance = new RunMaintenance({ root, runtime: app.runtime, sessions: app.sessions,
    policy: { ...RUN_RETENTION, keep: 1 }, inspectOpenPaths: async () => [] });
  const result = await maintenance.sweep({ now: Date.now() + 8 * 86400000 });
  assert.ok(result.removed.includes(path.basename(oldRun)), JSON.stringify(result));
  assert.ok(fs.existsSync(path.join(workspaceDir, "outputs/article.md")));
  assert.ok((await app.sessions.list()).some(item => item.id === session.id));
  const restored = await app.sessions.ensure(session.id);
  assert.equal(restored.id, session.id); assert.ok(restored.turns.length > 0);
  await app.messages.submit({ threadId: session.id, clientMessageId: "second", text: "继续读取文章。" });
  await done(app, "second"); assert.deepEqual(provider.errors, []);
  assert.equal(step, 5);
  assert.equal(app.sessions.sessions.get(session.id).cwd, workspaceDir);
  fs.appendFileSync(path.join(root, "agents/writing/role.md"), "\nROLE_CHANGED\n");
  await assert.rejects(app.messages.submit({ threadId: session.id, clientMessageId: "blocked", text: "不能静默切换角色。" }), /已变更/);
  assert.equal((await app.tools.registry.call({ tool: "read_file", arguments: { path: "outputs/article.md" } })).success, false);
});

test("真实 Codex：Agent 包 Skill 同步到 CODEX_HOME 后显式注入；工作区里的 Skill 不启用", { timeout: 60000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  // 授权的 Skill 放在 Agent 包里；工作区里的同类文件属于用户数据，必须被关闭。
  for (const [name, dir] of [["core-allowed", "agents/writing/skills/core-allowed"], ["core-denied", "workspace/.agents/skills/core-denied"]]) {
    fs.mkdirSync(path.join(root, dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "SKILL.md"), "---\nname: " + name + "\ndescription: Integration fixture skill.\n---\n" + name.toUpperCase().replaceAll("-", "_") + "_INSTRUCTIONS\n");
    fs.writeFileSync(path.join(root, dir, "references/notes.md"), "参考资料\n");
  }
  definition(root, v => {
    v.agent.skills = [{ id: "outline", required: true }];
    v.bindings.skills = { outline: { path: "skills/core-allowed/SKILL.md" } };
  });
  const provider = await responsesFixture(root, body => {
    assert.ok(JSON.stringify(body).includes("CORE_ALLOWED_INSTRUCTIONS"), "完整 Skill 没有注入原生请求");
    assert.ok(!JSON.stringify(body).includes("CORE_DENIED_INSTRUCTIONS"));
    return answer("已使用允许的 Skill。");
  });
  const app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  cleanup(root, () => app.close());
  assert.equal(app.agent.availableSkills[0].name, "core-allowed");
  const installed = fs.realpathSync(path.join(root, ".data/codex/skills/outline/SKILL.md"));
  assert.equal(app.agent.availableSkills[0].path, installed);
  assert.ok(fs.existsSync(path.join(root, ".data/codex/skills/outline/references/notes.md")), "references 应随 Skill 同步");
  const session = await app.sessions.create();
  await app.messages.submit({ threadId: session.id, clientMessageId: "skill", text: "$core-allowed 提取观点。" });
  await done(app, "skill");
  assert.deepEqual(provider.errors, []);
  const listing = await app.rpc.request("skills/list", { cwds: [app.runtime.workspaceDir], forceReload: true });
  assert.equal(listing.data.flatMap(entry => entry.skills).find(skill => skill.name === "core-denied").enabled, false);
  await app.messages.submit({ threadId: session.id, clientMessageId: "denied", text: "$core-denied 不允许。" });
  await until(() => app.messages.job("denied").status === "failed");
  assert.equal(provider.requests.length, 1, "不允许的显式 Skill 请求不能发给模型");
  fs.appendFileSync(path.join(root, "agents/writing/skills/core-allowed/references/notes.md"), "改动\n");
  await assert.rejects(app.messages.submit({ threadId: session.id, clientMessageId: "changed", text: "继续" }), /已变更/, "Agent 包里的 Skill 被修改后应撤销");
});

test("真实 Codex：workspace 及上级目录的 AGENTS.md 不进入模型上下文，原生目标工具不可见", { timeout: 60000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "PARENT_AGENTS_FIXTURE\n");
  fs.writeFileSync(path.join(root, "workspace/AGENTS.md"), "WORKSPACE_AGENTS_FIXTURE\n");
  const provider = await responsesFixture(root, body => {
    const json = JSON.stringify(body), names = toolSpecs(body).map(tool => tool.name);
    assert.ok(!json.includes("PARENT_AGENTS_FIXTURE") && !json.includes("WORKSPACE_AGENTS_FIXTURE"), "AGENTS.md 进入了模型上下文");
    assert.ok(!names.some(name => /goal/.test(name || "")), `原生目标工具仍可见：${names}`);
    return answer("好的。");
  });
  const app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  cleanup(root, () => app.close());
  assert.deepEqual(app.rpc.capabilities.restrictedConfig, { project_doc_max_bytes: 0 });
  assert.ok(app.rpc.capabilities.restrictedFeatures.includes("goals"));
  const session = await app.sessions.create();
  await app.messages.submit({ threadId: session.id, clientMessageId: "agents-md", text: "你好" });
  await done(app, "agents-md");
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(provider.errors, []);
  await assert.rejects(app.rpc.request("thread/goal/set", { threadId: session.id, objective: "不应生效" }));
});

test("真实 Codex：自定义 workflow 注入任务说明与包内 Skill，按真实写入结果验收", { timeout: 60000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  fs.mkdirSync(path.join(root, "agents/writing/skills/report"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents/writing/skills/report/SKILL.md"), "---\nname: report\ndescription: 写报告的方法\n---\nREPORT_METHOD_FIXTURE\n");
  definition(root, v => {
    v.agent.tools.allow = ["list_files", "read_file", "write_file"];
    v.agent.skills = [{ id: "report", required: true }];
    v.bindings.skills = { report: { path: "skills/report/SKILL.md" } };
    v.agent.workflows = [{ id: "report", label: "写报告", skill: "report", checks: ["file-exists", "format"] }];
  });
  let step = 0;
  const provider = await responsesFixture(root, body => {
    const json = JSON.stringify(body);
    assert.ok(json.includes("【工作流】写报告（report）") && json.includes("产物文件存在"), "任务说明没有进入模型请求");
    assert.ok(json.includes("REPORT_METHOD_FIXTURE"), "workflow 指定的 Skill 没有注入");
    if (step++ === 0) return toolCall(toolSpecs(body).find(spec => spec.name?.endsWith("write_file")), { path: "outputs/report.md", content: "报告正文" });
    return answer("报告已保存。");
  });
  const app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  cleanup(root, () => app.close());
  const session = await app.sessions.create();
  await app.messages.submit({ threadId: session.id, clientMessageId: "report", text: "写一份周报", workflow: "report" });
  await done(app, "report");
  assert.deepEqual(provider.errors, []);
  assert.deepEqual(app.messages.job("report").checks.map(check => [check.id, check.passed]), [["file-exists", true], ["format", true]]);
  const user = app.sessions.snapshot(session.id).turns.at(-1).messages[0].text;
  assert.match(user, /写一份周报/);
});

test("真实 Codex：两步写文章——大纲后等待确认，确认后带补充说明定稿并验收", { timeout: 60000 }, async t => {
  const root = installToolFixture(tempRoot(t), { article: true });
  let step = 0;
  const bodies = [];
  const provider = await responsesFixture(root, body => {
    bodies.push(JSON.stringify(body));
    const write = (file, content) => toolCall(toolSpecs(body).find(spec => spec.name?.endsWith("write_file")), { path: file, content });
    return [() => write("drafts/outline.md", "大纲"), () => answer("大纲已保存，请确认。"),
      () => write("outputs/article.md", "正文"), () => answer("定稿已保存。")][step++]();
  });
  const app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  cleanup(root, () => app.close());
  const session = await app.sessions.create();
  await app.messages.submit({ threadId: session.id, clientMessageId: "article", text: "写一篇关于社区咖啡馆的文章", workflow: "write-article" });
  await until(() => app.messages.job("article").status === "waiting", 15000);
  assert.match(bodies[0], /第 1\/2 步：outline/);
  assert.match(bodies[0], /立意与大纲/, "write-article Skill 应注入");
  assert.ok(fs.existsSync(path.join(root, "workspace/drafts/outline.md")));
  await app.messages.confirm({ threadId: session.id, taskId: "article", text: "第二部分多写案例" });
  await done(app, "article");
  assert.match(bodies[2], /第 2\/2 步：final/);
  assert.match(bodies[2], /用户补充：第二部分多写案例/);
  assert.deepEqual(app.messages.job("article").checks.map(check => [check.id, check.passed]), [["file-exists", true], ["format", true]]);
  assert.equal(app.sessions.snapshot(session.id).turns.length, 2, "每一步是同一会话里的一轮");
  assert.deepEqual(provider.errors, []);
});

test("真实 Codex：模型按技能清单自行读取 Skill 与参考文件（隐式触发）；未启用的 Skill 读不到", { timeout: 60000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  const write = (dir, name, extra = {}) => {
    fs.mkdirSync(path.join(root, dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "SKILL.md"), `---\nname: ${name}\ndescription: DESC_${name} 写作检查方法\n---\nBODY_${name}\n`);
    for (const [file, body] of Object.entries(extra)) fs.writeFileSync(path.join(root, dir, file), body);
  };
  write("agents/writing/skills/method", "core-method", { "references/check.md": "CHECKLIST_FIXTURE" });
  write("workspace/.agents/skills/core-denied", "core-denied");
  definition(root, v => {
    v.agent.tools.allow = ["list_files", "read_file", "write_file", "skill_read"];
    v.agent.skills = [{ id: "method", required: true }];
    v.bindings.skills = { method: { path: "skills/method/SKILL.md" } };
  });
  let step = 0;
  const seen = [];
  const provider = await responsesFixture(root, body => {
    const json = JSON.stringify(body), read = args => toolCall(toolSpecs(body).find(spec => spec.name?.endsWith("skill_read")), args);
    seen.push(json);
    if (step === 0) {
      assert.ok(json.includes("DESC_core-method"), "已启用 Skill 的描述应出现在技能清单里");
      assert.ok(!json.includes("BODY_core-method"), "没有显式调用时不应预先注入正文");
      assert.ok(!json.includes("DESC_core-denied"), "未启用的 Skill 不出现在技能清单里");
    }
    return [() => read({ name: "core-method" }), () => read({ name: "core-method", file: "references/check.md" }),
      () => read({ name: "core-denied" }), () => answer("已按方法检查。")][step++]();
  });
  const app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  cleanup(root, () => app.close());
  const session = await app.sessions.create();
  await app.messages.submit({ threadId: session.id, clientMessageId: "implicit", text: "帮我检查这段文字的写法" });
  await done(app, "implicit");
  assert.deepEqual(provider.errors, []);
  assert.ok(seen[1].includes("BODY_core-method"), "skill_read 应返回 SKILL.md 正文");
  assert.ok(seen[2].includes("CHECKLIST_FIXTURE"), "skill_read 应能读取 references");
  assert.match(seen[3], /Skill 未启用或不存在：core-denied/);
  const tools = Object.values(app.sessions.snapshot(session.id).turns.at(-1).tools);
  assert.deepEqual(tools.map(tool => tool.status), ["completed", "completed", "failed"]);
});
