import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ToolManager, createToolService, readToolSources } from "../server/modules/tools/index.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { prepareCodexConfig, codexPaths } from "../server/modules/codex/config.mjs";
import { EventHub } from "../server/modules/events/index.mjs";
import { tempRoot, installToolFixture, fixture, cleanup, until } from "./helpers.mjs";

const definition = { name: "echo_note", label: "回显", description: "回显文字", readOnly: true,
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } };
function addTool(root, module = "export const createTools = () => ({ echo_note: ({text}) => ({text}) });") {
  fs.writeFileSync(path.join(root, "server/modules/tools/extra.mjs"), module);
  fs.writeFileSync(path.join(root, "config/tools/extra.json"), JSON.stringify({ module: "server/modules/tools/extra.mjs", tools: [definition] }));
}

test("配置驱动新工具，不修改主程序或分发分支；禁用配置不加载模块", async t => {
  const root = installToolFixture(tempRoot(t));
  addTool(root);
  const registry = await createToolService(root);
  assert.equal(registry.specs.length, 6);
  assert.deepEqual(JSON.parse((await registry.call({ tool: "echo_note", arguments: { text: "你好" } })).contentItems[0].text), { text: "你好" });
  fs.writeFileSync(path.join(root, "config/tools/extra.json"), JSON.stringify({ enabled: false, module: "does-not-exist.mjs" }));
  assert.equal((await createToolService(root)).specs.length, 5);
});

test("拒绝重名、缺少实现、无效 schema、越界模块和配置符号链接", async t => {
  const root = installToolFixture(tempRoot(t));
  const file = path.join(root, "config/tools/extra.json");
  addTool(root);
  for (const data of [
    { module: "server/modules/tools/extra.mjs", tools: [definition, definition] },
    { module: "server/modules/tools/extra.mjs", tools: [{ ...definition, name: "no_handler" }] },
    { module: "server/modules/tools/extra.mjs", tools: [{ ...definition, inputSchema: { type: "object", unknownKeyword: true } }] },
    { module: "server/modules/tools/extra.mjs", tools: [{ ...definition, name: undefined }] },
    { module: "server/modules/tools/../../private.mjs", tools: [definition] },
    { module: "server/modules/tools/extra.mjs", enabled: "yes", tools: [definition] }
  ]) {
    fs.writeFileSync(file, JSON.stringify(data));
    await assert.rejects(createToolService(root));
  }
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(root, "config/tools/files.json"), file);
  assert.throws(() => readToolSources(root), /符号链接/);
});

test("工具代码和相对依赖使用版本快照，新版本不会复用旧 ESM 缓存", async t => {
  const root = installToolFixture(tempRoot(t));
  fs.writeFileSync(path.join(root, "server/modules/tools/value.mjs"), 'export const value = "v1";');
  addTool(root, 'import {value} from "./value.mjs"; export const createTools = () => ({ echo_note: () => value });');
  const a = await createToolService(root, { snapshotDir: path.join(root, "snapshot-a") });
  fs.writeFileSync(path.join(root, "server/modules/tools/value.mjs"), 'export const value = "v2";');
  const b = await createToolService(root, { snapshotDir: path.join(root, "snapshot-b") });
  const call = registry => registry.call({ tool: "echo_note", arguments: { text: "x" } }).then(r => JSON.parse(r.contentItems[0].text));
  assert.equal(await call(a), "v1"); assert.equal(await call(b), "v2");
  assert.notEqual(a.version, b.version);
});

async function managerFixture(t) {
  const root = installToolFixture(tempRoot(t));
  const config = loadServerConfig(root, fixture), runtime = await prepareRun(config.launch, root);
  const manager = new ToolManager({ config, runtime, log: () => {}, redact: value => String(value) });
  cleanup(root, () => manager.close());
  await manager.open();
  prepareCodexConfig(config, manager.configuration());
  const sessions = { sessions: new Map() }, calls = [], hub = new EventHub();
  let selected = manager.registry, fail = false;
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === "config/value/write") { selected = manager.server.registries.get(params.value.url.split("/").at(-1)); return {}; }
    if (method === "config/mcpServer/reload") { if (fail) { fail = false; throw new Error("模拟刷新失败"); } return {}; }
    if (method === "mcpServerStatus/list") return { data: [{ name: "project_tools", tools: Object.fromEntries(selected.specs.map(tool => [tool.name, tool])), toolsError: null }], nextCursor: null };
    throw new Error(method);
  } };
  manager.attach({ rpc, isBusy: () => [...sessions.sessions.values()].some(session => session.activeTurnId), hub });
  return { root, config, manager, sessions, calls, hub, failNextReload: () => { fail = true; } };
}

test("全部 Thread 空闲后才更新；开始新轮和更新共用边界锁", async t => {
  const { root, manager, sessions, calls } = await managerFixture(t);
  sessions.sessions.set("other-window", { activeTurnId: "running-turn" });
  const old = manager.registry.version;
  addTool(root);
  await manager.poll();
  assert.equal(manager.registry.version, old);
  assert.equal(calls.length, 0);
  assert.equal(await manager.atBoundary(() => "new-session", { allowBusy: true }), "new-session", "新建/查看会话不能被其他窗口的长任务阻塞");
  let started = false;
  const next = manager.atBoundary(() => { started = true; assert.notEqual(manager.registry.version, old); });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(started, false);
  sessions.sessions.get("other-window").activeTurnId = null;
  await next;
  assert.equal(started, true);
  assert.deepEqual(calls.map(call => call.method), ["config/value/write", "config/mcpServer/reload", "mcpServerStatus/list"]);
});

test("目录自动检查增删；失败只通知一次，恢复正确配置后解除错误状态", async t => {
  const { root, manager, hub } = await managerFixture(t);
  const events = []; hub.on("event", event => events.push(event));
  addTool(root);
  await until(() => manager.registry.specs.some(tool => tool.name === "echo_note"), 3000);
  const current = manager.registry.version;
  const file = path.join(root, "config/tools/extra.json");
  fs.writeFileSync(file, "{");
  await manager.poll(); await manager.poll();
  assert.equal(manager.registry.version, current);
  assert.equal(events.filter(event => event.data.status === "degraded").length, 1);
  addTool(root);
  await manager.poll();
  assert.equal(manager.snapshot().status, "ready");
  fs.unlinkSync(file);
  await manager.poll();
  assert.ok(!manager.registry.specs.some(tool => tool.name === "echo_note"));
});

test("RPC 刷新失败回滚配置；加载器故障不替换旧实现", async t => {
  const { root, manager, calls, failNextReload } = await managerFixture(t);
  const old = manager.registry.version;
  addTool(root); failNextReload();
  await manager.poll();
  assert.equal(manager.registry.version, old);
  assert.equal(manager.broken, undefined);
  assert.equal(calls.filter(call => call.method === "config/value/write").length, 2);
  assert.match(manager.error, /模拟刷新失败/);
  addTool(root, 'throw new Error("模块无效");');
  await manager.poll();
  assert.equal(manager.registry.version, old);
  assert.match(manager.error, /模块无效/);
  assert.equal(calls.filter(call => call.method === "config/value/write").length, 2);
});

test("MCP 入口只监听回环，拒绝无令牌和浏览器跨源，不把凭证写进配置", async t => {
  const { config, manager } = await managerFixture(t);
  const url = manager.connection(manager.registry).url;
  assert.match(url, /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await fetch(url, { method: "POST" })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${manager.token}`, origin: "https://untrusted.invalid" } })).status, 403);
  const file = fs.readFileSync(manager.configFile, "utf8");
  assert.ok(!file.includes(manager.token)); assert.ok(!file.includes(fixture.CODEX_API_KEY));
  assert.equal(fs.statSync(manager.configFile).mode & 0o777, 0o600);
  assert.equal(config.launch.env.CODEX_HOME, codexPaths(config.root).home);
});
