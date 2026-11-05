import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { AGENT_INSTRUCTIONS } from "../05-app-server.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { buildAppServerLaunch } from "../05-app-server.mjs";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { SessionService } from "../server/modules/sessions/index.mjs";
import { fixture, tempRoot, rig, until, installToolFixture } from "./helpers.mjs";

function configured(root, environment) {
  installToolFixture(root);
  const config = loadServerConfig(root, environment);
  const agent = new AgentDefinition(root);
  agent.configure(config, { workspaceDir: path.join(root, "workspace") });
  return config;
}

const catalogConfig = {
  ...fixture, CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000"
};

test("正式服务角色由 Agent 装配，模型目录复用同一份指令", t => {
  const root = tempRoot(t);
  const environment = { ...catalogConfig };
  const config = configured(root, environment);
  assert.equal(config.launch.catalog.models[0].model_messages.instructions_template, config.agent.instructions);
  assert.ok(config.agent.instructions.startsWith(AGENT_INSTRUCTIONS));
  assert.match(config.agent.instructions, /保存分类规则：[\s\S]*outputs\/notes\//);
  assert.deepEqual(environment, catalogConfig);
  assert.equal(existsSync(path.join(root, ".data", "role.json")), false);
  assert.equal(existsSync(path.join(root, ".runs")), false);
});

test("旧 .env 角色不覆盖项目角色，也不改写原文件或改变模型和权限配置", t => {
  const root = tempRoot(t);
  const file = path.join(root, ".env");
  const original = 'AGENT_INSTRUCTIONS="旧的编程助手指令"\n';
  writeFileSync(file, original);
  const config = configured(root, { ...catalogConfig, AGENT_INSTRUCTIONS: "终端中的旧指令" });
  assert.equal(config.launch.catalog.models[0].model_messages.instructions_template, config.agent.instructions);
  assert.equal(config.launch.model, fixture.CODEX_MODEL);
  assert.equal(config.launch.catalog.models[0].shell_type, "disabled");
  assert.equal(config.launch.catalog.models[0].apply_patch_tool_type, null);
  assert.ok(config.launch.args.includes('web_search="disabled"'));
  assert.equal(readFileSync(file, "utf8"), original);
});

test("旧 demo 的目录也只使用角色模块，缺少或残留环境提示词都不影响角色", () => {
  for (const environment of [catalogConfig, { ...catalogConfig, AGENT_INSTRUCTIONS: "旧案例自定义指令" }]) {
    const launch = buildAppServerLaunch(environment);
    assert.equal(launch.catalog.models[0].model_messages.instructions_template, AGENT_INSTRUCTIONS);
  }
});

test("无模型目录时，新建会话也传装配后的角色，且不放宽权限", async t => {
  const r = await rig(t);
  assert.equal(r.config.launch.catalog, null);
  const { params } = r.rpc.calls.find(call => call.method === "thread/start");
  assert.equal(params.baseInstructions, r.config.agent.instructions);
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.model, fixture.CODEX_MODEL);
  assert.equal(params.modelProvider, "project_api");
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 0);
});

test("恢复历史和新建会话共用角色，不从旧目录重新取出过期角色", async t => {
  const r = await rig(t);
  await r.submit("我的观点", "first");
  await until(() => r.messages.job("first").status === "running");
  r.rpc.finish(r.session.id);
  const originalTurns = r.sessions.snapshot(r.session.id).turns;
  r.sessions.close();
  const runtime = await prepareRun(r.config.launch, r.root);
  const config = { ...r.config, launch: { ...r.config.launch, catalog: { models: [{ model_messages: { instructions_template: "旧角色" } }] } } };
  const sessions = new SessionService({ rpc: r.rpc, config, runtime, hub: r.hub, redact: r.redact });
  r.cleanup(() => sessions.close());
  const resumed = await sessions.ensure(r.session.id);
  const { params } = r.rpc.calls.find(call => call.method === "thread/resume");
  assert.equal(params.baseInstructions, r.config.agent.instructions);
  assert.equal(params.cwd, r.runtime.workspaceDir);
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.approvalPolicy, "never");
  assert.equal(resumed.id, r.session.id);
  assert.deepEqual(resumed.turns, originalTurns);
  await sessions.ensure(r.session.id);
  assert.equal(r.rpc.calls.filter(call => call.method === "thread/resume").length, 1);
});

test("多轮消息仍原样提交，不将角色 prompt 重复拼入用户输入", async t => {
  const r = await rig(t);
  r.rpc.mode = "early";
  await r.submit("先帮我提取观点", "first");
  await r.submit("只润色上面那段话", "second");
  await until(() => r.messages.job("second").status === "completed");
  assert.equal(r.rpc.calls.filter(call => call.method === "thread/start").length, 1);
  const requests = r.rpc.calls.filter(call => call.method === "turn/start");
  assert.deepEqual(requests.map(call => call.params.input[0].text), ["先帮我提取观点", "只润色上面那段话"]);
  assert.ok(requests.every(call => call.params.threadId === r.session.id));
  assert.notEqual(r.messages.job("first").turnId, r.messages.job("second").turnId);
});
