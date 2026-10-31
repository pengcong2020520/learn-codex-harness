// 多用户/tool hub 相关协议探针：#35894 多连接广播、共用进程的隔离、每用户一个进程的开销、MCP 热重载能否影响已存在的 Thread。
// 用法：node probe-multi.mjs [--cli path/to/codex.js] [--only s6,s7,s8]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "../../server/modules/config/index.mjs";
import { prepareRun } from "../../server/modules/codex/runtime.mjs";
import { prepareCodexConfig } from "../../server/modules/codex/config.mjs";
import { CodexConnection } from "../../server/modules/codex/connection.mjs";
import { sendResponse, answer, toolSpecs } from "../responses-fixture.mjs";
import { redactLocalPaths } from "./redact.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const cli = opt("--cli") ? path.resolve(opt("--cli")) : path.join(here, "../../node_modules/@openai/codex/bin/codex.js");
const outputDir = process.env.PROTOCOL_REPORT_DIR;
if (!outputDir) throw new Error("Run npm run test:protocol:research");
const codexVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "../package.json"))).version;
const only = opt("--only")?.split(",");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let respond = () => answer("ok");
const requests = [];
const http = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
  requests.push({ at: Date.now(), body });
  try { sendResponse(res, await respond(body)); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => http.listen(0, "127.0.0.1", r));
const providerUrl = `http://127.0.0.1:${http.address().port}/v1`;
const call = (spec, a = {}) => ({ type: "function_call", id: randomUUID(), call_id: randomUUID(), name: spec.name,
  ...(spec.namespace ? { namespace: spec.namespace } : {}), arguments: JSON.stringify(a), status: "completed" });
const toolOutputs = body => { const inp = body.input || []; let k = -1; inp.forEach((i, n) => { if (i.role === "user") k = n; });
  return inp.slice(k + 1).filter(i => i.type === "function_call_output" || i.type === "custom_tool_call_output"); };
const names = body => toolSpecs(body).map(t => t.namespace ? `${t.namespace}${t.name}` : t.name).sort();
const DYN = [{ type: "function", name: "probe_echo", description: "Echo.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const threadOpts = { sandbox: "read-only", approvalPolicy: "never", baseInstructions: "probe", model: "local-test-model", modelProvider: "project_api" };
const input = text => [{ type: "text", text, text_elements: [] }];
const env = { CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: providerUrl, CODEX_MODEL: "local-test-model",
  CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "90000" };
function makeRoot(mcp = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-multi-"));
  for (const d of [".runs", "workspace"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const config = loadServerConfig(root, { ...env, AGENT_DEFINITION: "probe-agent.json" }); prepareCodexConfig(config, mcp); return { root, config };
}
const results = { codexVersion, node: process.version, at: new Date().toISOString(), tests: {} };
const record = (id, data) => { results.tests[id] = data; console.log(`\n[${id}]`, JSON.stringify(data, null, 2)); };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
function treeRssKb(pid) {
  const out = execSync("ps -eo pid=,ppid=,rss=").toString().trim().split("\n").map(l => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [p, pp, rss] of out) { (kids.get(pp) || kids.set(pp, []).get(pp)).push([p, rss]); }
  let total = 0; const self = out.find(x => x[0] === pid); if (self) total += self[2];
  const walk = p => { for (const [c, rss] of kids.get(p) || []) { total += rss; walk(c); } }; walk(pid); return total;
}

// ---------- WebSocket 版 JSON-RPC 客户端 ----------
class WsClient {
  constructor(name, url) { Object.assign(this, { name, url, seq: 0, pending: new Map(), got: [], onRequest: null }); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = e => rej(new Error("ws error")); });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data); this.got.push({ at: Date.now(), m });
      if (m.method && m.id !== undefined) { this.onRequest?.(m); return; }
      if (m.id !== undefined) { const w = this.pending.get(m.id); if (w) { this.pending.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } }
    };
    await this.request("initialize", { clientInfo: { name: "probe_" + this.name, title: "probe", version: "1" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  request(method, params) { const id = ++this.seq; this.send({ id, method, params });
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.delete(id)) rej(new Error(method + " 超时")); }, 30000); }); }
  waitTurn(threadId, ms = 20000) { const start = this.got.length; return new Promise((res, rej) => { const t0 = Date.now();
    const iv = setInterval(() => { const hit = this.got.slice(start).find(x => x.m.method === "turn/completed" && x.m.params.threadId === threadId);
      if (hit) { clearInterval(iv); res(hit.m.params.turn); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("turn 未结束")); } }, 50); }); }
  close() { try { this.ws.close(); } catch {} }
}
async function startWsServer() {
  const { root, config } = makeRoot();
  const runtime = await prepareRun(config.launch, root);
  const port = await freePort();
  const args = runtime.args.map(a => a === "stdio://" ? `ws://127.0.0.1:${port}` : a);
  const child = spawn(process.execPath, [cli, ...args], { cwd: runtime.workspaceDir, env: config.launch.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", d => { stderr += d; });
  for (let i = 0; i < 100; i++) { try { await new Promise((res, rej) => { const s = net.connect(port, "127.0.0.1", () => { s.end(); res(); }); s.on("error", rej); }); break; } catch { await sleep(100); } }
  return { url: `ws://127.0.0.1:${port}`, child, root, stderr: () => stderr };
}

// S6：#35894 —— 两个连接订阅同一个 Thread 时，item/tool/call 发给谁、用谁的回复；以及不同 Thread 之间的隔离
if (!only || only.includes("s6")) {
  const srv = await startWsServer();
  const A = new WsClient("A", srv.url), B = new WsClient("B", srv.url);
  await A.open(); await B.open();
  A.onRequest = m => { if (m.method === "item/tool/call") process.env.DELAY_A === "never" ? null : setTimeout(() => A.send({ id: m.id, result: { success: true, contentItems: [{ type: "inputText", text: "reply-from-A" }] } }), Number(process.env.DELAY_A ?? 800)); else A.send({ id: m.id, error: { code: -32601, message: "unsupported" } }); };
  B.onRequest = m => { if (m.method === "item/tool/call") process.env.DELAY_B === "never" ? null : setTimeout(() => B.send({ id: m.id, result: { success: true, contentItems: [{ type: "inputText", text: "reply-from-B" }] } }), Number(process.env.DELAY_B ?? 0)); else B.send({ id: m.id, error: { code: -32601, message: "unsupported" } }); };
  let seenOutput;
  respond = body => { const o = toolOutputs(body); if (o.length) { seenOutput ??= o.at(-1).output; return answer("done"); } return call(toolSpecs(body).find(s => s.name === "probe_echo")); };
  const t = await A.request("thread/start", { ...threadOpts, cwd: path.join(srv.root, "workspace"), dynamicTools: DYN });
  // 先跑一轮让 rollout 落盘，否则别的连接 resume 不到
  { const keep = respond; respond = () => answer("warmup"); const d = A.waitTurn(t.thread.id); await A.request("turn/start", { threadId: t.thread.id, input: input("warmup") }); await d; respond = keep; }
  let resumeB; try { await B.request("thread/resume", { ...threadOpts, threadId: t.thread.id, cwd: path.join(srv.root, "workspace") }); resumeB = "ok"; } catch (e) { resumeB = "error: " + e.message; }
  const a0 = A.got.length, b0 = B.got.length;
  const starter = process.env.TURN_BY === "B" ? B : A;
  const done = starter.waitTurn(t.thread.id);
  await starter.request("turn/start", { threadId: t.thread.id, input: input("call tool") });
  let turn; try { turn = await done; } catch (e) { turn = { status: "未结束（20 秒内没有 turn/completed）" }; } await sleep(1500);
  const calls = c => c.got.filter(x => x.m.method === "item/tool/call").map(x => ({ requestId: x.m.id, callId: x.m.params.callId }));
  const aCalls = calls({ got: A.got.slice(a0) }), bCalls = calls({ got: B.got.slice(b0) });
  const bNotifs = [...new Set(B.got.slice(b0).filter(x => x.m.method && x.m.id === undefined).map(x => x.m.method))];
  // 隔离：C 是另一个“用户”，只建自己的 Thread，看能否收到 A 的事件、能否列出/读取 A 的 Thread
  const C = new WsClient("C", srv.url); await C.open();
  C.onRequest = m => C.send({ id: m.id, result: { success: true, contentItems: [{ type: "inputText", text: "reply-from-C" }] } });
  const tc = await C.request("thread/start", { ...threadOpts, cwd: path.join(srv.root, "workspace"), dynamicTools: DYN });
  const c0 = C.got.length;
  if (process.env.TURN_BY || process.env.DELAY_A === "never" || process.env.DELAY_B === "never") { record("s6_variant", { TURN_BY: process.env.TURN_BY || "A", DELAY_A: process.env.DELAY_A, DELAY_B: process.env.DELAY_B, turnStatus: turn.status, modelGotOutput: seenOutput, toolCallDeliveredToA: calls({ got: A.got.slice(a0) }).length, toolCallDeliveredToB: calls({ got: B.got.slice(b0) }).length }); process.exit(0); }
  B.close(); await sleep(300);
  const d2 = A.waitTurn(t.thread.id);
  await A.request("turn/start", { threadId: t.thread.id, input: input("again") }); const turn2 = await d2; await sleep(500);
  const cSawA = C.got.slice(c0).filter(x => JSON.stringify(x.m.params || {}).includes(t.thread.id)).map(x => x.m.method);
  let cList; try { const l = await C.request("thread/list", {}); cList = (l.data || []).map(x => x.id); } catch (e) { cList = "error: " + e.message; }
  let cRead; try { const r = await C.request("thread/read", { threadId: t.thread.id }); cRead = r?.thread?.id === t.thread.id ? "可以读取 A 的 Thread" : "无内容"; } catch (e) { cRead = "error: " + e.message; }
  let cResume; try { await C.request("thread/resume", { ...threadOpts, threadId: t.thread.id, cwd: path.join(srv.root, "workspace") }); cResume = "可以订阅 A 的 Thread"; } catch (e) { cResume = "error: " + e.message; }
  record("s6_multi_connection", { bResumeSameThread: resumeB, turnStatus: turn.status,
    toolCallDeliveredToA: aCalls, toolCallDeliveredToB: bCalls, sameRequestIdBroadcast: aCalls.length && bCalls.length && aCalls[0].requestId === bCalls[0].requestId,
    modelGotOutput: seenOutput, bReceivedNotifications: bNotifs, secondTurnAfterBDisconnect: turn2.status,
    otherUserC_receivedEventsOfAThread: cSawA, otherUserC_threadListContainsA: Array.isArray(cList) ? cList.includes(t.thread.id) : cList,
    otherUserC_threadRead: cRead, otherUserC_threadResume: cResume });
  A.close(); C.close(); srv.child.kill("SIGTERM"); await sleep(500);
}

// S7：每个用户一个 App Server 进程的开销（启动到可用的耗时、空闲常驻内存）
if (!only || only.includes("s7")) {
  const N = 4; const out = [];
  const conns = [];
  for (let i = 0; i < N; i++) {
    const { root, config } = makeRoot();
    const runtime = await prepareRun(config.launch, root);
    const rpc = new CodexConnection({ launch: config.launch, runtime, redact: x => typeof x === "string" ? x : JSON.stringify(x), cli, log: () => {} });
    const t0 = Date.now(); await rpc.open(); const openMs = Date.now() - t0;
    const t1 = Date.now(); await rpc.request("thread/start", { ...threadOpts, cwd: runtime.workspaceDir, dynamicTools: DYN }); const threadMs = Date.now() - t1;
    conns.push(rpc); await sleep(500);
    out.push({ openMs, threadStartMs: threadMs, rssMb: Math.round(treeRssKb(rpc.child.pid) / 1024) });
  }
  record("s7_process_per_user_cost", { processes: N, each: out, cpuCount: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1048576) });
  for (const c of conns) await c.close();
}

// S8：tool hub 热插拔走 MCP —— 改工具表 + config/mcpServer/reload 后，已存在的 Thread 下一轮能否看到新工具 / 失去旧工具
if (!only || only.includes("s8")) {
  const toolsFile = path.join(os.tmpdir(), `hub-tools-${process.pid}.json`);
  fs.writeFileSync(toolsFile, JSON.stringify(["hub_alpha"]));
  const { root, config } = makeRoot({ hub: { command: process.execPath, args: [path.join(here, "hub-mcp.mjs"), toolsFile] } });
  const open = async () => { const runtime = await prepareRun(config.launch, root);
    const rpc = new CodexConnection({ launch: config.launch, runtime, redact: x => typeof x === "string" ? x : JSON.stringify(x), cli, log: () => {} }); await rpc.open(); return { rpc, runtime }; };
  const turnOn = async (rpc, threadId, text) => { let seen; const before = requests.length;
    respond = body => { seen ??= names(body).filter(n => n.includes("hub")); return answer("ok"); };
    const done = new Promise(res => { const on = m => { if (m.method === "turn/completed" && m.params.threadId === threadId) { rpc.off("notification", on); res(m.params.turn.status); } }; rpc.on("notification", on); });
    await rpc.request("turn/start", { threadId, input: input(text) }); const status = await done; return { status, hubTools: seen, modelRequests: requests.length - before }; };
  let { rpc, runtime } = await open();
  const t = await rpc.request("thread/start", { ...threadOpts, cwd: runtime.workspaceDir });
  const r1 = await turnOn(rpc, t.thread.id, "one");
  fs.writeFileSync(toolsFile, JSON.stringify(["hub_beta"]));
  const r2noReload = await turnOn(rpc, t.thread.id, "two");
  let reload; try { await rpc.request("config/mcpServer/reload"); reload = "ok"; } catch (e) { reload = "error: " + e.message; }
  await sleep(1500);
  const r3 = await turnOn(rpc, t.thread.id, "three");
  // 项目的做法：改 config.toml 里的 MCP 配置（项目是换带版本号的 URL），再 reload
  prepareCodexConfig(config, { hub: { command: process.execPath, args: [path.join(here, "hub-mcp.mjs"), toolsFile, "v2"] } });
  let reload2; try { await rpc.request("config/mcpServer/reload"); reload2 = "ok"; } catch (e) { reload2 = "error: " + e.message; }
  await sleep(1500);
  const r3b = await turnOn(rpc, t.thread.id, "three-b");
  const t2 = await rpc.request("thread/start", { ...threadOpts, cwd: runtime.workspaceDir });
  const r4 = await turnOn(rpc, t2.thread.id, "new thread");
  // 旧 Thread 调已移除的 hub_alpha（模型凭历史调用）：看工具结果
  let out; respond = body => { const o = toolOutputs(body); if (o.length) { out = o.at(-1).output; return answer("done"); }
    const spec = toolSpecs(body).find(s => s.name.includes("hub_")); return spec ? { ...call(spec), name: spec.name.replace("hub_beta", "hub_alpha") } : answer("no hub"); };
  const done = new Promise(res => { const on = m => { if (m.method === "turn/completed" && m.params.threadId === t.thread.id) { rpc.off("notification", on); res(m.params.turn.status); } }; rpc.on("notification", on); });
  await rpc.request("turn/start", { threadId: t.thread.id, input: input("call removed") });
  const r5 = { status: await Promise.race([done, sleep(30000).then(() => "timeout")]), modelSawOutput: out };
  await rpc.close();
  record("s8_mcp_hot_reload", { turn1_initial: r1, turn2_fileChanged_noReload: r2noReload, reload, turn3_sameThread_afterReload: r3, configChangedReload: reload2, turn3b_sameThread_afterConfigChange: r3b, newThread_afterReload: r4, sameThread_callRemovedTool: r5 });
  fs.rmSync(toolsFile, { force: true });
}

http.close(); http.closeAllConnections();
const outFile = path.join(outputDir, `results-multi-${codexVersion}.json`);
fs.writeFileSync(outFile, redactLocalPaths(JSON.stringify(results, null, 2)));
console.log("\n结果已写入", outFile);
process.exit(0);
