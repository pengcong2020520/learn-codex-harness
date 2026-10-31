// codex-harness 协议层回归探针：真实 Codex App Server + 本机模拟 Responses 模型，不用真实 key、不需要 PG/Redis。
// 用法：node probe.mjs [--cli path/to/codex.js] [--only s1,s2,...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "./project/server/modules/config/index.mjs";
import { prepareRun } from "./project/server/modules/codex/runtime.mjs";
import { prepareCodexConfig } from "./project/server/modules/codex/config.mjs";
import { CodexConnection } from "./project/server/modules/codex/connection.mjs";
import { PermissionGate } from "./project/server/modules/permissions/index.mjs";
import { sendResponse, answer, toolSpecs } from "./project/tests/responses-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cli = opt("--cli") ? path.resolve(opt("--cli")) : path.join(here, "project/node_modules/@openai/codex/bin/codex.js");
const codexVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "../package.json"))).version;
const only = opt("--only")?.split(",");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 模拟模型 ----------
let respond = () => answer("ok");
const requests = [];
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
  requests.push({ at: Date.now(), body });
  try { sendResponse(res, await respond(body)); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const providerUrl = `http://127.0.0.1:${server.address().port}/v1`;

const call = (spec, argsObj, callId = randomUUID()) => ({ type: "function_call", id: randomUUID(), call_id: callId,
  name: spec.name, ...(spec.namespace ? { namespace: spec.namespace } : {}), arguments: JSON.stringify(argsObj), status: "completed" });
// 只看当前这轮（最后一条用户消息之后）的工具结果，避免历史里的旧结果干扰
const toolOutputs = body => { const inp = body.input || []; let k = -1; inp.forEach((i, n) => { if (i.role === "user") k = n; });
  return inp.slice(k + 1).filter(i => i.type === "function_call_output"); };
const names = body => toolSpecs(body).map(t => t.namespace ? `${t.namespace}.${t.name}` : t.name).sort();

// ---------- 连接 ----------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-"));
fs.mkdirSync(path.join(root, ".runs"), { recursive: true });
fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
const config = loadServerConfig(root, { CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: providerUrl,
  CODEX_MODEL: "local-test-model", CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "90000" });
prepareCodexConfig(config, {});
const runs = [];
async function connect() {
  const runtime = await prepareRun(config.launch, root);
  const rpc = new CodexConnection({ launch: config.launch, runtime, redact: x => typeof x === "string" ? x : JSON.stringify(x), cli, log: () => {} });
  rpc.on("fatal", e => console.error("FATAL", e.message));
  await rpc.open();
  runs.push(runtime.runDir);
  return { rpc, runtime };
}
const protocol = runtime => fs.readFileSync(path.join(runtime.runDir, "protocol.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
function turnDone(rpc, threadId, ms = 60000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { rpc.off("notification", on); reject(new Error("turn 未在时限内结束")); }, ms);
    const on = m => { if (m.method === "turn/completed" && m.params.threadId === threadId) { clearTimeout(t); rpc.off("notification", on); resolve(m.params.turn); } };
    rpc.on("notification", on);
  });
}
const DYN = [
  { type: "function", name: "probe_echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  { type: "function", name: "legacy_tool", description: "A tool that will later be removed.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
];
const threadOpts = { sandbox: "read-only", approvalPolicy: "never", baseInstructions: "probe" , model: "local-test-model", modelProvider: "project_api" };
const input = text => [{ type: "text", text, text_elements: [] }];

const results = { codexVersion, node: process.version, at: new Date().toISOString(), tests: {} };
const record = (id, data) => { results.tests[id] = data; console.log(`\n[${id}]`, JSON.stringify(data, null, 2)); };

let conn = await connect();

// S1+S5：实际注册的工具 & 模型看到的完整工具列表
if (!only || only.includes("s1")) {
  respond = () => answer("hello");
  const before = requests.length;
  const t = await conn.rpc.request("thread/start", { ...threadOpts, cwd: conn.runtime.workspaceDir, dynamicTools: DYN });
  const done = turnDone(conn.rpc, t.thread.id);
  await conn.rpc.request("turn/start", { threadId: t.thread.id, input: input("hi") });
  const turn = await done;
  const body = requests[before].body;
  const list = names(body);
  fs.writeFileSync(path.join(here, `tools-${codexVersion}.json`), JSON.stringify(list, null, 2));
  record("s1_s5_registered_tools", { turnStatus: turn.status, toolCount: list.length, tools: list,
    dynamicToolsVisible: DYN.every(d => list.some(n => n.endsWith(d.name))),
    nativeExecOrPatch: list.filter(n => /shell|exec|apply_patch|view_image|web_search|spawn|agent/i.test(n)) });
}

// S2：时序。turn/started 与 item/tool/call、turn/start 响应的先后；按 main.mjs 接线的门禁是否误拒
if (!only || only.includes("s2")) {
  const gate = new PermissionGate({ scope: { ownerId: "probe" }, agent: { definition: { agent: { id: "probe", knowledge: [] } }, assertCurrent() {} } });
  const onN = m => { const p = m.params; if (m.method === "turn/started") gate.started(p.threadId, p.turn.id); if (m.method === "turn/completed") gate.end(p.threadId, p.turn.id); };
  conn.rpc.on("notification", onN);
  let denied = 0, allowed = 0;
  conn.rpc.toolHandler = async params => {
    try { gate.forTurn(params.threadId, params.turnId); allowed++; }
    catch { denied++; throw new Error("门禁拒绝"); }
    return { success: true, contentItems: [{ type: "inputText", text: "echo:" + JSON.stringify(params.arguments) }] };
  };
  respond = body => toolOutputs(body).length ? answer("done") : call(toolSpecs(body).find(s => s.name === "probe_echo"), { text: "x" });
  const t = await conn.rpc.request("thread/start", { ...threadOpts, cwd: conn.runtime.workspaceDir, dynamicTools: DYN });
  const N = 20; const statuses = [];
  for (let i = 0; i < N; i++) {
    gate.start({ id: "job" + i, threadId: t.thread.id });
    const done = turnDone(conn.rpc, t.thread.id);
    await conn.rpc.request("turn/start", { threadId: t.thread.id, input: input("call tool " + i) });
    statuses.push((await done).status);
    gate.end(t.thread.id);
  }
  conn.rpc.off("notification", onN);
  // 从协议日志统计先后顺序
  const log = protocol(conn.runtime);
  const order = {}; // turnId -> {started, toolCall, startResponse}
  const startReqIds = new Set(log.filter(x => x.direction === "client" && x.message.method === "turn/start").map(x => x.message.id));
  log.forEach((x, i) => {
    const m = x.message;
    if (x.direction === "server" && m.method === "turn/started") (order[m.params.turn.id] ??= {}).started = i;
    if (x.direction === "server" && m.method === "item/tool/call") { const o = (order[m.params.turnId] ??= {}); o.toolCall ??= i; o.callIds = [...(o.callIds || []), m.params.callId]; }
    if (x.direction === "server" && m.id !== undefined && !m.method && startReqIds.has(m.id) && m.result?.turn) (order[m.result.turn.id] ??= {}).startResponse = i;
  });
  const turns = Object.values(order).filter(o => o.toolCall !== undefined);
  record("s2_ordering_gate", { turns: N, statuses: [...new Set(statuses)], gateAllowed: allowed, gateDenied: denied,
    toolCallBeforeTurnStarted: turns.filter(o => o.toolCall < o.started).length,
    toolCallBeforeTurnStartResponse: turns.filter(o => o.startResponse !== undefined && o.toolCall < o.startResponse).length,
    turnStartedBeforeResponse: turns.filter(o => o.started < o.startResponse).length,
    duplicateCallIdDeliveries: turns.filter(o => new Set(o.callIds).size !== o.callIds.length).length });
}

// S3a：工具遵守 signal，30s 硬超时
if (!only || only.includes("s3")) {
  let aborted = null;
  conn.rpc.toolHandler = (params, { signal }) => new Promise((_, reject) => {
    const t0 = Date.now(); signal.addEventListener("abort", () => { aborted = Date.now() - t0; reject(new Error("工具超时")); });
  });
  let outputSeen = null;
  respond = body => { const outs = toolOutputs(body); if (outs.length) { outputSeen = outs.at(-1).output; return answer("after timeout"); } return call(toolSpecs(body).find(s => s.name === "probe_echo"), { text: "slow" }); };
  const t = await conn.rpc.request("thread/start", { ...threadOpts, cwd: conn.runtime.workspaceDir, dynamicTools: DYN });
  const done = turnDone(conn.rpc, t.thread.id, 90000);
  const t0 = Date.now();
  await conn.rpc.request("turn/start", { threadId: t.thread.id, input: input("slow tool") });
  const turn = await done;
  record("s3a_tool_timeout_respects_signal", { abortedAfterMs: aborted, turnStatus: turn.status, turnMs: Date.now() - t0, modelSawOutput: outputSeen });

  // S3b：工具无视 signal + 客户端 turn/interrupt；之后迟到回包；连接是否仍健康
  let resolveLate; let handlerCalls = 0;
  conn.rpc.toolHandler = () => { handlerCalls++; return new Promise(r => { resolveLate = r; }); };
  const reqBefore = requests.length;
  respond = body => toolOutputs(body).length ? answer("should not happen") : call(toolSpecs(body).find(s => s.name === "probe_echo"), { text: "hang" });
  const t2 = await conn.rpc.request("thread/start", { ...threadOpts, cwd: conn.runtime.workspaceDir, dynamicTools: DYN });
  const done2 = turnDone(conn.rpc, t2.thread.id, 30000);
  const st = await conn.rpc.request("turn/start", { threadId: t2.thread.id, input: input("hang tool") });
  await sleep(3000);
  let interruptResult;
  try { interruptResult = await conn.rpc.request("turn/interrupt", { threadId: t2.thread.id, turnId: st.turn.id }); interruptResult = "ok"; } catch (e) { interruptResult = "error: " + e.message; }
  let turn2; try { turn2 = await done2; } catch (e) { turn2 = { status: "NO turn/completed: " + e.message }; }
  const reqAfterInterrupt = requests.length - reqBefore;
  const logLen = protocol(conn.runtime).length;
  resolveLate({ success: true, contentItems: [{ type: "inputText", text: "late" }] });
  await sleep(2000);
  const tail = protocol(conn.runtime).slice(logLen).map(x => ({ d: x.direction, method: x.message.method, id: x.message.id, error: x.message.error?.message }));
  await sleep(1000);
  const modelRequestsAfterLate = requests.length - reqBefore - reqAfterInterrupt;
  // 健康检查：同一连接再跑一轮
  conn.rpc.toolHandler = async () => ({ success: true, contentItems: [{ type: "inputText", text: "ok" }] });
  respond = () => answer("healthy");
  let healthy;
  try { const d = turnDone(conn.rpc, t2.thread.id, 20000); await conn.rpc.request("turn/start", { threadId: t2.thread.id, input: input("are you ok") }); healthy = (await d).status; } catch (e) { healthy = "error: " + e.message; }
  record("s3b_interrupt_with_hung_tool", { interruptResult, turnStatus: turn2.status, handlerCalls, modelRequestsDuringTurn: reqAfterInterrupt,
    lateReplyProtocolTail: tail, modelRequestsAfterLateReply: modelRequestsAfterLate, connectionFailure: conn.rpc.failure?.message || null, nextTurnOnSameThread: healthy });
}

// S4：旧 Thread（以旧工具表创建）在重启 + 工具删除后被恢复并调用已删除工具；以及 resume 传新 dynamicTools 是否被忽略（#24808）
if (!only || only.includes("s4")) {
  respond = () => answer("created");
  const t = await conn.rpc.request("thread/start", { ...threadOpts, cwd: conn.runtime.workspaceDir, dynamicTools: DYN });
  const d0 = turnDone(conn.rpc, t.thread.id); await conn.rpc.request("turn/start", { threadId: t.thread.id, input: input("first") }); await d0;
  await conn.rpc.close();
  conn = await connect(); // 模拟服务重启
  const allowedNow = new Set(["probe_echo"]); // legacy_tool 已删除
  let handlerSaw = [];
  conn.rpc.toolHandler = async params => { handlerSaw.push(params.tool); if (!allowedNow.has(params.tool)) throw new Error("工具已不在允许范围"); return { success: true, contentItems: [{ type: "inputText", text: "ok" }] }; };
  let toolsSeen, outSeen;
  respond = body => { toolsSeen ??= names(body); const outs = toolOutputs(body); if (outs.length) { outSeen = outs.at(-1).output; return answer("handled"); }
    const spec = toolSpecs(body).find(s => s.name === "legacy_tool"); return spec ? call(spec, {}) : answer("legacy_tool not visible"); };
  const NEW = [DYN[0], { type: "function", name: "brand_new_tool", description: "new", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
  let resumeErr = null;
  try { await conn.rpc.request("thread/resume", { ...threadOpts, threadId: t.thread.id, cwd: conn.runtime.workspaceDir, excludeTurns: false, dynamicTools: NEW }); }
  catch (e) { resumeErr = e.message; }
  const d1 = turnDone(conn.rpc, t.thread.id, 30000); let turn;
  try { await conn.rpc.request("turn/start", { threadId: t.thread.id, input: input("call legacy") }); turn = await d1; } catch (e) { turn = { status: "error: " + e.message }; }
  record("s4_deleted_tool_on_resumed_thread", { resumeWithNewDynamicToolsError: resumeErr, modelSawTools: toolsSeen,
    legacyStillVisible: toolsSeen?.includes("legacy_tool"), newToolVisibleAfterResume: toolsSeen?.includes("brand_new_tool"),
    handlerSaw, modelSawToolOutput: outSeen, turnStatus: turn.status });
}

await conn.rpc.close();
server.close(); server.closeAllConnections();
const out = path.join(here, `results-${codexVersion}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 2));
fs.cpSync(runs.at(-1), path.join(here, `last-run-${codexVersion}`), { recursive: true });
console.log("\n结果已写入", out);
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
