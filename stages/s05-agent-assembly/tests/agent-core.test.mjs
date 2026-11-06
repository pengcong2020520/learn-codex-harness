import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { verifySkills } from "../server/modules/codex/skills.mjs";
import { fixture, installAgentFixture, tempRoot, rig, until } from "./helpers.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";

function edit(root, change) {
  const file = path.join(root, "agents/writing-agent.json"), value = JSON.parse(fs.readFileSync(file));
  change(value); fs.writeFileSync(file, JSON.stringify(value));
}
async function assemble(t, change = () => {}) {
  const root = installAgentFixture(tempRoot(t)); edit(root, change);
  const config = loadServerConfig(root, fixture), agent = new AgentDefinition(root);
  const runtime = await prepareRun(config.launch, root, { workspaceDir: agent.workspacePath, instructions: agent.instructions });
  agent.configure(config, runtime); agent.activate([]);
  return { root, config, agent, runtime };
}

test("Agent schema 拒绝未知字段、缺失必需引用、原生权限提升和越出目录的角色路径", t => {
  const root = installAgentFixture(tempRoot(t)), original = fs.readFileSync(path.join(root, "agents/writing-agent.json"));
  for (const change of [v => v.extra = true, v => v.agent.executionRef = "missing", v => delete v.agent.instructions,
    v => v.bindings.executions["restricted-local"].nativeShell = true, v => v.bindings.executions["restricted-local"].sandbox = "workspace-write",
    v => v.agent.instructions = "../.env", v => v.agent.id = "1-bad"]) {
    fs.writeFileSync(path.join(root, "agents/writing-agent.json"), original); edit(root, change);
    assert.throws(() => new AgentDefinition(root));
  }
});

test("角色由 Agent 定义指定的文件装配，进入模型目录和会话的 baseInstructions", async t => {
  const { config, agent } = await assemble(t);
  assert.match(agent.instructions, /^你是“AI 知识整理助手”/);
  assert.equal(config.agent, agent);
  const r = await rig(t);
  const start = r.rpc.calls.find(call => call.method === "thread/start").params;
  assert.equal(start.baseInstructions, r.config.agent.instructions);
  const withCatalog = loadServerConfig(r.root, { ...fixture, CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000" });
  new AgentDefinition(r.root).configure(withCatalog, r.runtime);
  assert.equal(withCatalog.launch.catalog.models[0].model_messages.instructions_template, withCatalog.agent.instructions);
});

test("定义、角色任一文件变了，旧版本立即作废；恢复原文件也不能免重启", async t => {
  const { root, agent } = await assemble(t);
  agent.assertCurrent();
  const role = path.join(root, "agents/roles/writing-assistant.md"), original = fs.readFileSync(role);
  fs.appendFileSync(role, "\n多一句");
  assert.throws(() => agent.assertCurrent(), /已变更/);
  fs.writeFileSync(role, original);
  assert.throws(() => agent.assertCurrent(), /已变更/, "撤销被检测后，恢复文件也不能免重启");
});

test("描述符不复制角色正文或密钥；无绑定的旧会话和不兼容版本明确拒绝", async t => {
  const { agent, root } = await assemble(t);
  agent.bind("thread-test"); agent.assertCompatible("thread-test");
  assert.throws(() => agent.assertCompatible("legacy"), /旧会话/);
  assert.throws(() => agent.assertCompatible("thread-test", "old-job"), /不兼容/);
  const descriptor = fs.readFileSync(path.join(root, ".data/agent-descriptors", `${agent.descriptor.hash}.json`), "utf8");
  assert.ok(!descriptor.includes(fixture.CODEX_API_KEY)); assert.ok(!descriptor.includes("你的任务是"));
  agent.activate([{ name: "new-skill", path: "/skills/new/SKILL.md", version: "v2" }]);
  assert.throws(() => agent.assertCompatible("thread-test"), /不兼容/, "Skill 集合变化也会产生新版本");
});

test("排队执行前检查版本；版本变化不发送下一轮、不重复重发", async t => {
  const r = await rig(t); await r.submit("first", "a");
  await until(() => r.messages.job("a").status === "running");
  await r.submit("next", "b");
  r.config.agent.activate([{ name: "changed", path: "/skills/changed/SKILL.md", version: "v1" }]); r.rpc.finish(r.session.id);
  await until(() => r.messages.job("b").status === "failed");
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 1);
});

test("原生 Skill 发现核验与显式输入；新发现的范围外 Skill 被禁用", async t => {
  const { agent, runtime } = await assemble(t);
  const discovered = [{ path: "/allowed/SKILL.md", name: "allowed", enabled: false }, { path: "/other/SKILL.md", name: "other", enabled: true }];
  // 仅接口夹具：不声称此处证明原生 Skill 解析行为。
  const configured = { ...agent, skills: [{ id: "allowed-id", path: discovered[0].path, required: true, version: "v1" }] };
  const rpc = { async request(method, params) {
    if (method === "skills/list") return { data: [{ skills: structuredClone(discovered) }] };
    if (method === "skills/config/write") { discovered.find(item => item.path === params.path).enabled = params.enabled; return {}; }
    throw new Error(method);
  } };
  const skills = await verifySkills(rpc, configured, runtime.workspaceDir);
  assert.equal(discovered[1].enabled, false); assert.equal(skills[0].name, "allowed");
  agent.availableSkills = skills;
  agent.deniedSkillNames = configured.deniedSkillNames;
  assert.equal(agent.input("$allowed 提炼观点")[1].type, "skill");
  assert.throws(() => agent.input("$other 执行"), /未授权/);
  assert.equal(agent.input("请解释 $HOME 变量").length, 1, "普通变量文字不能被误当成非法 Skill");
  assert.equal(agent.input("$allowed-longer").length, 1, "Skill 名称不能按前缀误匹配");
});

test("必需 Skill 缺失或有未满足依赖启动报错；可选引用明确降级", t => {
  const root = installAgentFixture(tempRoot(t));
  edit(root, v => v.agent.skills = [{ id: "missing", required: true }]);
  assert.throws(() => new AgentDefinition(root), /缺少必需 Skill/);
  edit(root, v => v.agent.skills[0].required = false);
  assert.match(new AgentDefinition(root).warnings[0], /可选 Skill/);
  edit(root, v => { v.agent.skills[0].required = true; v.bindings.skills.missing = { path: "not-installed", requires: ["shell"] }; });
  assert.throws(() => new AgentDefinition(root), /依赖尚未支持/);
});

test("多轮消息仍原样提交，不将角色 prompt 重复拼入用户输入", async t => {
  const r = await rig(t);
  r.rpc.mode = "early";
  await r.submit("先帮我提取观点", "first");
  await r.submit("只润色上面那段话", "second");
  await until(() => r.messages.job("second").status === "completed");
  const requests = r.rpc.calls.filter(call => call.method === "turn/start");
  assert.deepEqual(requests.map(call => call.params.input[0].text), ["先帮我提取观点", "只润色上面那段话"]);
});
