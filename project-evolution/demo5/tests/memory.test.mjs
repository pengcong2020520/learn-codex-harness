import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadServerConfig, createLogRedactor } from "../server/modules/config/index.mjs";
import { prepareCodexConfig, codexPaths } from "../server/modules/codex/config.mjs";
import { MemoryService } from "../server/modules/memory/index.mjs";
import { tempRoot, fixture } from "./helpers.mjs";

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
      min_rollout_idle_hours: config.memory.minIdleHours } };
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

test("接受旧工具配置头；拒绝接管外部配置、符号链接和硬链接", t => {
  const f = memoryFixture(t);
  fs.writeFileSync(f.paths.configFile, "# project-managed MCP configuration\n");
  prepareCodexConfig(f.config, {});
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
