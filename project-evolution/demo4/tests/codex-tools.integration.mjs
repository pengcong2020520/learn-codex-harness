import { testDataFactory } from './jobs-fixture.mjs';
// 真 Codex 0.154.0 + 本机模拟 Responses，不读取 .env，不使用真实模型密钥。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startAgentServer } from "../server/main.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { RunMaintenance, RUN_RETENTION } from "../server/modules/maintenance/index.mjs";
import { tempRoot, cleanup, until, installToolFixture } from "./helpers.mjs";
import { responsesFixture, answer, toolCall, toolSpecs } from "./responses-fixture.mjs";

function definition(root, change) {
  const file = path.join(root, "agents/writing-agent.json");
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
  fs.appendFileSync(path.join(root, "agents/roles/writing-assistant.md"), "\nROLE_ASSEMBLY_FIXTURE\n");
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
  fs.appendFileSync(path.join(root, "agents/roles/writing-assistant.md"), "\nROLE_CHANGED\n");
  await assert.rejects(app.messages.submit({ threadId: session.id, clientMessageId: "blocked", text: "不能静默切换角色。" }), /已变更/);
  assert.equal((await app.tools.registry.call({ tool: "read_file", arguments: { path: "outputs/article.md" } })).success, false);
});

test("真实 Codex：原生 Skill 发现、显式正文注入与范围外拒绝", { timeout: 60000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  for (const name of ["core-allowed", "core-denied"]) {
    const dir = path.join(root, "workspace/.agents/skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: Integration fixture skill.\n---\n" + name.toUpperCase().replaceAll("-", "_") + "_INSTRUCTIONS\n");
  }
  definition(root, v => {
    v.agent.skills = [{ id: "outline", required: true }];
    v.bindings.skills = { outline: { path: ".agents/skills/core-allowed/SKILL.md" } };
  });
  const provider = await responsesFixture(root, body => {
    assert.ok(JSON.stringify(body).includes("CORE_ALLOWED_INSTRUCTIONS"), "完整 Skill 没有注入原生请求");
    assert.ok(!JSON.stringify(body).includes("CORE_DENIED_INSTRUCTIONS"));
    return answer("已使用允许的 Skill。");
  });
  const app = await startAgentServer({ dataFactory: testDataFactory, config: configFor(root, provider), log: () => {} });
  cleanup(root, () => app.close());
  assert.equal(app.agent.availableSkills[0].name, "core-allowed");
  const session = await app.sessions.create();
  await app.messages.submit({ threadId: session.id, clientMessageId: "skill", text: "$core-allowed 提取观点。" });
  await done(app, "skill");
  assert.deepEqual(provider.errors, []);
  const listing = await app.rpc.request("skills/list", { cwds: [app.runtime.workspaceDir], forceReload: true });
  assert.equal(listing.data.flatMap(entry => entry.skills).find(skill => skill.name === "core-denied").enabled, false);
  await app.messages.submit({ threadId: session.id, clientMessageId: "denied", text: "$core-denied 不允许。" });
  await until(() => app.messages.job("denied").status === "failed");
  assert.equal(provider.requests.length, 1, "不允许的显式 Skill 请求不能发给模型");
});
