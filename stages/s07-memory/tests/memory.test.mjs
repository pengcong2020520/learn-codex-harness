import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadServerConfig, createLogRedactor } from "../server/modules/config/index.mjs";
import { prepareCodexConfig, codexPaths } from "../server/modules/codex/config.mjs";
import { MemoryService } from "../server/modules/memory/index.mjs";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { tempRoot, fixture, installAgentFixture, rig } from "./helpers.mjs";

function memoryFixture(t, env = {}) {
  const root = tempRoot(t), calls = [];
  const config = loadServerConfig(root, { ...fixture, ...env });
  const paths = prepareCodexConfig(config, {});
  const sessions = { sessions: new Map([["thread-1", { activeTurnId: null }]]),
    async ensure(id) { if (!this.sessions.has(id)) throw new Error("未找到本项目的这个会话"); },
    async atBoundary(operation) { return operation(); } };
  const actual = { features: { memories: config.memory.enabled, shell_tool: false, apply_patch_freeform: false },
    memories: { use_memories: config.memory.use, generate_memories: config.memory.generate,
      extract_model: config.memory.extractModel, consolidation_model: config.memory.consolidationModel,
      min_rollout_idle_hours: config.memory.minIdleHours, dedicated_tools: true } };
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === "config/read") return { config: { ...actual, secret: fixture.CODEX_API_KEY } };
    if (method === "thread/memoryMode/set") return {};
    throw new Error(method);
  } };
  const memory = new MemoryService({ rpc, config, sessions, redact: createLogRedactor(fixture.CODEX_API_KEY) });
  return { root, config, paths, memory, calls, actual, rpc, sessions };
}

test("记忆默认关闭；复用当前模型，覆盖模型和配置严格校验", t => {
  const f = memoryFixture(t);
  assert.equal(f.config.memory.enabled, false);
  assert.equal(f.config.memory.extractModel, fixture.CODEX_MODEL);
  assert.equal(f.config.memory.consolidationModel, fixture.CODEX_MODEL);
  for (const env of [{ AGENT_MEMORY_ENABLED: "1" }, { AGENT_MEMORY_USE: "no" }, { AGENT_MEMORY_GENERATE: "yes" },
    { AGENT_MEMORY_MIN_IDLE_HOURS: "0" }, { AGENT_MEMORY_MIN_IDLE_HOURS: "49" }, { AGENT_MEMORY_MIN_IDLE_HOURS: "1.5" },
    { AGENT_MEMORY_EXTRACT_MODEL: "bad\nmodel" }]) assert.throws(() => loadServerConfig(f.root, { ...fixture, ...env }));
  const explicit = loadServerConfig(f.root, { ...fixture, AGENT_MEMORY_ENABLED: "true", AGENT_MEMORY_EXTRACT_MODEL: "extract-only", AGENT_MEMORY_CONSOLIDATION_MODEL: "merge-only" });
  assert.equal(explicit.memory.extractModel, "extract-only");
  assert.equal(explicit.memory.consolidationModel, "merge-only");
  assert.equal(explicit.launch.model, fixture.CODEX_MODEL);
});

test("公共配置统一写入 MCP/记忆并保留原生数据，隔离 CODEX_HOME 和 SQLite 路径", t => {
  const f = memoryFixture(t, { CODEX_HOME: "/never-use-personal", CODEX_SQLITE_HOME: "/never-use-state", AGENT_MEMORY_ENABLED: "true" });
  fs.mkdirSync(f.paths.memories);
  fs.writeFileSync(path.join(f.paths.memories, "memory_summary.md"), "已有记忆");
  prepareCodexConfig(f.config, { project_tools: { url: "http://127.0.0.1:1000/v2", bearer_token_env_var: "PROJECT_MCP_TOKEN" } });
  const source = fs.readFileSync(f.paths.configFile, "utf8");
  assert.match(source, /\[features\]\nmemories = true/);
  assert.match(source, /\[memories\]/);
  assert.match(source, /\[mcp_servers.project_tools\]/);
  assert.ok(!source.includes(fixture.CODEX_API_KEY));
  assert.equal(fs.statSync(f.paths.configFile).mode & 0o777, 0o600);
  assert.equal(f.config.launch.env.CODEX_HOME, f.paths.home);
  assert.equal(f.config.launch.env.CODEX_SQLITE_HOME, f.paths.home);
  assert.equal(fs.readFileSync(path.join(f.paths.memories, "memory_summary.md"), "utf8"), "已有记忆");
});

test("拒绝接管外部配置、符号链接和硬链接", t => {
  const f = memoryFixture(t);
  fs.writeFileSync(f.paths.configFile, "# user-managed\n");
  assert.throws(() => prepareCodexConfig(f.config, {}), /不是本项目生成/);
  const external = path.join(f.root, "external.toml");
  fs.writeFileSync(external, "untouched");
  fs.unlinkSync(f.paths.configFile);
  fs.symlinkSync(external, f.paths.configFile);
  assert.throws(() => prepareCodexConfig(f.config, {}), /普通文件/);
  fs.unlinkSync(f.paths.configFile);
  fs.linkSync(external, f.paths.configFile);
  assert.throws(() => prepareCodexConfig(f.config, {}), /普通文件/);
  assert.equal(fs.readFileSync(external, "utf8"), "untouched");
});

test("拒绝状态目录符号链接，不能写入个人目录", t => {
  const root = tempRoot(t), outside = tempRoot(t);
  fs.mkdirSync(path.join(root, ".data"));
  fs.symlinkSync(outside, codexPaths(root).home);
  assert.throws(() => prepareCodexConfig(loadServerConfig(root, fixture), {}), /状态目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("只读核验实际配置；不开启模型，不虚构生成进度或已生成状态", async t => {
  const f = memoryFixture(t, { AGENT_MEMORY_ENABLED: "true" });
  assert.throws(() => f.memory.snapshot(), /尚未核验/);
  await f.memory.verify();
  const state = f.memory.snapshot();
  assert.equal(state.effective.enabled, true);
  assert.equal(state.hasSummary, false);
  assert.equal(state.generationCapability, "blocked");
  assert.equal(state.generationProgress, "unknown");
  assert.ok(!JSON.stringify(state).includes(fixture.CODEX_API_KEY));
  assert.deepEqual(f.calls.map(call => call.method), ["config/read"]);
  f.actual.memories.use_memories = false;
  await assert.rejects(f.memory.verify(), /不一致/);
  f.actual.memories.use_memories = f.config.memory.use;
  await f.memory.verify();
  f.actual.memories.dedicated_tools = false;
  await assert.rejects(f.memory.verify(), /不一致/, "受限记忆工具没有按配置开启也要报不一致");
});

test("摘要缺失有明确状态、限长脱敏，元数据查询不返回正文", async t => {
  const f = memoryFixture(t);
  await f.memory.verify();
  assert.equal(f.memory.summary().exists, false);
  fs.mkdirSync(f.paths.memories);
  fs.writeFileSync(path.join(f.paths.memories, "memory_summary.md"), `观点 ${fixture.CODEX_API_KEY} ` + "a".repeat(70000));
  const summary = f.memory.summary();
  assert.equal(summary.truncated, true);
  assert.ok(summary.text.includes("[REDACTED]"));
  assert.ok(summary.text.length <= 65536);
  const state = f.memory.snapshot();
  assert.equal(state.hasSummary, true);
  assert.equal(state.artifacts["memory_summary.md"].text, undefined);
});

test("记忆读取拒绝文件/目录链接和硬链接，不从其他目录召回", async t => {
  const f = memoryFixture(t);
  fs.mkdirSync(f.paths.memories);
  const external = path.join(f.root, "external.txt"), summary = path.join(f.paths.memories, "memory_summary.md");
  fs.writeFileSync(external, "不可读");
  fs.symlinkSync(external, summary);
  assert.throws(() => f.memory.summary());
  fs.unlinkSync(summary); fs.linkSync(external, summary);
  assert.throws(() => f.memory.summary(), /独立普通文件/);
  fs.unlinkSync(summary); fs.rmdirSync(f.paths.memories); fs.symlinkSync(f.root, f.paths.memories);
  assert.throws(() => f.memory.summary(), /真实目录/);
});

test("参与设置只调用原生接口；校验项目归属、参数、活动 turn 和总开关", async t => {
  const f = memoryFixture(t);
  await f.memory.verify();
  await assert.rejects(f.memory.contribute("thread-1", true), /总开关/);
  await assert.rejects(f.memory.contribute("thread-1", "true"), /布尔值/);
  await assert.rejects(f.memory.contribute("foreign", false), /本项目/);
  f.sessions.sessions.get("thread-1").activeTurnId = "running";
  await assert.rejects(f.memory.contribute("thread-1", false), /结束后/);
  f.sessions.sessions.get("thread-1").activeTurnId = null;
  const result = await f.memory.contribute("thread-1", false);
  assert.equal(result.mode, "disabled");
  assert.match(result.note, /不立即删除/);
  assert.deepEqual(f.calls.at(-1), { method: "thread/memoryMode/set", params: { threadId: "thread-1", mode: "disabled" } });
  assert.ok(!fs.existsSync(path.join(f.root, ".data/memory.json")), "不复制原生会话状态到另一份记忆库");
});

test("Agent 记忆策略与服务配置取交集，配置进入描述符并约束旧会话", t => {
  const root = installAgentFixture(tempRoot(t));
  const file = path.join(root, "agents/writing-agent.json"), definition = JSON.parse(fs.readFileSync(file));
  const runtime = { workspaceDir: path.join(root, "workspace") };
  const config = loadServerConfig(root, { ...fixture, AGENT_MEMORY_ENABLED: "true" });
  const agent = new AgentDefinition(root);
  agent.configure(config, runtime); agent.activate("unit-tools", []); agent.bind("thread-1");
  assert.equal(config.memory.use, false);
  assert.equal(config.memory.contribute, false);
  assert.equal(config.memory.generate, true, "后台生成开关与会话贡献策略独立");
  assert.deepEqual(agent.descriptor.memory, config.memory);
  const changed = loadServerConfig(root, { ...fixture, AGENT_MEMORY_ENABLED: "true", AGENT_MEMORY_GENERATE: "false" });
  const restarted = new AgentDefinition(root);
  restarted.configure(changed, runtime); restarted.activate("unit-tools", []);
  assert.throws(() => restarted.assertCompatible("thread-1"), /不兼容/);

  definition.agent.memory = { use: true, contribute: true };
  fs.writeFileSync(file, JSON.stringify(definition));
  const allowed = loadServerConfig(root, { ...fixture, AGENT_MEMORY_ENABLED: "true", AGENT_MEMORY_USE: "false" });
  new AgentDefinition(root).configure(allowed, runtime);
  assert.equal(allowed.memory.use, false, "Agent 不能越过服务端读取开关");
  assert.equal(allowed.memory.contribute, true);
  const disabled = loadServerConfig(root, fixture);
  new AgentDefinition(root).configure(disabled, runtime);
  assert.equal(disabled.memory.contribute, false, "总开关关闭时新会话不贡献记忆");
  definition.agent.memory.contribute = "true";
  fs.writeFileSync(file, JSON.stringify(definition));
  assert.throws(() => new AgentDefinition(root));
});

test("新建会话先设置原生记忆参与模式，再绑定并发布；恢复不覆盖已有模式", async t => {
  const r = await rig(t);
  assert.deepEqual(r.rpc.calls.filter(call => call.method === "thread/memoryMode/set"), [
    { method: "thread/memoryMode/set", params: { threadId: r.session.id, mode: "disabled" } }
  ]);
  r.config.memory.contribute = true;
  const created = await r.sessions.create();
  assert.deepEqual(r.rpc.calls.at(-1), { method: "thread/memoryMode/set", params: { threadId: created.id, mode: "enabled" } });
  r.config.agent.assertCompatible(created.id);
  r.sessions.sessions.delete(created.id);
  await r.sessions.ensure(created.id);
  assert.equal(r.rpc.calls.filter(call => call.method === "thread/memoryMode/set").length, 2);
});

test("原生记忆参与设置失败时，新会话不绑定版本、不发布可用快照", async t => {
  const r = await rig(t), request = r.rpc.request.bind(r.rpc), events = [];
  r.hub.on("event", event => events.push(event));
  r.rpc.request = (method, params) => {
    if (method === "thread/memoryMode/set") throw new Error("记忆模式设置失败");
    return request(method, params);
  };
  await assert.rejects(r.sessions.create(), /记忆模式设置失败/);
  assert.equal(r.sessions.sessions.size, 1);
  assert.throws(() => r.config.agent.assertCompatible("thread-2"), /旧会话/);
  assert.equal(events.length, 0);
});

test("会话参与设置不能越过 Agent 策略；允许时原生接口收到 enabled", async t => {
  const f = memoryFixture(t, { AGENT_MEMORY_ENABLED: "true" });
  f.config.agent = {};
  f.config.memory.contribute = false;
  await f.memory.verify();
  await assert.rejects(f.memory.contribute("thread-1", true), /Agent 策略/);
  assert.deepEqual(f.calls.map(call => call.method), ["config/read"]);
  f.config.memory.contribute = true;
  assert.equal((await f.memory.contribute("thread-1", true)).mode, "enabled");
  assert.deepEqual(f.calls.at(-1), { method: "thread/memoryMode/set", params: { threadId: "thread-1", mode: "enabled" } });
});
