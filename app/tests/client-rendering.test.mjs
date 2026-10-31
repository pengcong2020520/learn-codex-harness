import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTerminal } from "../client/modules/terminal/index.mjs";
import { runChat } from "../client/modules/chat/index.mjs";
import { until } from "./helpers.mjs";

const THREAD_ID = "01a0b819-39cf-74b3-b786-54d303c0aa57";
const TURN_ID = "01a0b819-3a46-7a33-b2b5-49692ca7ecdd";

test("/tools 无需创建会话即可查看工具，不发模型消息", async t => {
  const f = terminalFixture(t), calls = [];
  const api = { async request(route) { calls.push(route); return { status: "ready", pending: false, error: null, tools: [{ name: "read_file", label: "读取文件" }] }; } };
  const done = runChat(api, f.terminal);
  f.input.end("/tools\n/exit\n");
  await done;
  assert.deepEqual(calls, ["/tools"]);
  assert.match(f.text(), /read_file：读取文件/);
});

function terminalFixture(t, columns = null) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (columns) {
    const previousTerm = process.env.TERM;
    process.env.TERM = "xterm-256color";
    t.after(() => { if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm; });
    input.isTTY = output.isTTY = true;
    input.setRawMode = () => {};
    output.columns = columns;
  }
  let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const terminal = createTerminal(input, output);
  t.after(() => { terminal.close(); input.destroy(); output.destroy(); });
  return { input, output, terminal, text: () => text };
}

test("CLI 记忆查询不创建会话或发起模型请求，未选 Thread 不修改参与设置", async t => {
  const f = terminalFixture(t), calls = [];
  const api = { async request(route) {
    calls.push(route);
    return route === "/memory" ? { effective: { enabled: true, use: true, generate: true }, hasSummary: false,
      directory: ".data/codex/memories", generationWarning: "测试限制", note: "不是即时生成" } : { text: "合成偏好", truncated: false };
  } };
  const done = runChat(api, f.terminal);
  f.input.end("/memory\n/memory show\n/memory contribute on\n/memory reset\n/exit\n");
  await done;
  assert.deepEqual(calls, ["/memory", "/memory/summary"]);
  assert.match(f.text(), /尚无产物/);
  assert.match(f.text(), /合成偏好/);
  assert.match(f.text(), /请先新建或恢复会话/);
});

// 小型终端屏幕模型：执行 readline 输出的光标/清屏指令，而不是简单删除 ANSI。
// 这样能够发现“字符串拼对了，但实际屏幕把回复或输入擦掉了”的回归。
function screen(text, columns) {
  let rows = [[]], x = 0, y = 0;
  function row() { return rows[y] ||= []; }
  for (const match of text.matchAll(/\x1b\[([\d;]*)([A-Za-z])|([^\x1b])/gu)) {
    const [, params, command, char] = match;
    if (command) {
      const n = Number(params) || 1;
      if (command === "G") x = n - 1;
      else if (command === "A") y = Math.max(0, y - n);
      else if (command === "B") y += n;
      else if (command === "C") x += n;
      else if (command === "D") x = Math.max(0, x - n);
      else if (command === "J" && !Number(params)) { rows.length = y + 1; row().length = x; }
      else throw new Error(`屏幕模型尚未支持：${match[0]}`);
      continue;
    }
    if (char === "\r") { x = 0; continue; }
    if (char === "\n") { y++; x = 0; continue; }
    if (char === "\t") { x += 8 - x % 8; continue; }
    const code = char.codePointAt(0);
    const width = (code >= 0x2e80 && code <= 0xff60) || code >= 0x1f300 ? 2 : 1;
    if (x + width > columns) { y++; x = 0; }
    row()[x++] = char;
    if (width === 2) row()[x++] = "";
  }
  return { text: rows.map(line => Array.from(line, cell => cell ?? " ").join("").trimEnd()).join("\n").trimEnd(), x, y };
}

test("流式片段连续输出，保留模型段落和列表，结束只补必要换行", t => {
  const f = terminalFixture(t);
  for (const chunk of ["Agent：你", "好", "！\n", "\n- 第一", "条\n- 第二条"]) f.terminal.stream(chunk);
  f.terminal.endStream();
  f.terminal.endStream();
  assert.equal(f.text(), "Agent：你好！\n\n- 第一条\n- 第二条\n");
});

test("TTY 重绘只更新回复，不丢失正在编辑的输入与光标", t => {
  const f = terminalFixture(t, 80);
  f.terminal.write(`Thread id: ${THREAD_ID}`);
  f.terminal.stream("Agent：你好");
  f.terminal.rl.write("待发送的消息");
  f.terminal.rl.write(null, { name: "left" });
  f.terminal.rl.write(null, { name: "left" });
  const { line, cursor } = f.terminal.rl;
  f.terminal.stream("！\n\n有什么可以帮你？");
  assert.equal(f.terminal.rl.line, line);
  assert.equal(f.terminal.rl.cursor, cursor);
  assert.equal(screen(f.text(), 80).text, `Thread id: ${THREAD_ID}\nAgent：你好！\n\n有什么可以帮你？\n你 > 待发送的消息`);
  assert.equal(screen(f.text(), 80).x, 5 + cursor * 2);
  f.terminal.endStream();
  assert.equal(f.terminal.rl.line, line);
  assert.equal(f.terminal.rl.cursor, cursor);
  assert.equal(screen(f.text(), 80).text, `Thread id: ${THREAD_ID}\nAgent：你好！\n\n有什么可以帮你？\n你 > 待发送的消息`);
  assert.equal(screen(f.text(), 80).x, 5 + cursor * 2);
});

test("窄终端中文输入自动折行后，回复更新和日志仍保留输入与完整回复", t => {
  const f = terminalFixture(t, 20);
  f.terminal.write("开始");
  f.terminal.stream("Agent：这是一段会自动折行的中文回复");
  f.terminal.rl.write("这也是一条会自动折行的用户输入");
  for (let i = 0; i < 8; i++) f.terminal.rl.write(null, { name: "left" });
  const { line, cursor } = f.terminal.rl;
  f.terminal.stream("，继续输出。");
  f.terminal.write("连接正常");
  f.terminal.endStream();
  assert.equal(f.terminal.rl.line, line);
  assert.equal(f.terminal.rl.cursor, cursor);
  assert.equal(screen(f.text(), 20).text.replaceAll("\n", ""), "开始连接正常Agent：这是一段会自动折行的中文回复，继续输出。你 > 这也是一条会自动折行的用户输入");
});

test("输出中途提交新输入，不重复已经显示的回复片段", t => {
  const f = terminalFixture(t, 80);
  f.terminal.stream("Agent：第一部分");
  f.terminal.rl.write("补充要求");
  const lines = [];
  f.terminal.rl.on("line", line => { lines.push(line); f.terminal.prompt(); });
  f.terminal.rl.write(null, { name: "return" });
  f.terminal.stream("第二部分");
  f.terminal.endStream();
  assert.deepEqual(lines, ["补充要求"]);
  assert.equal(screen(f.text(), 80).text, "Agent：第一部分\n你 > 补充要求\n第二部分\n你 >");
});

test("普通日志不黏到非 TTY 回复末尾，模型控制字符不能清屏", t => {
  const f = terminalFixture(t);
  f.terminal.stream("Agent：正文\x1b[2J\x00");
  f.terminal.write("连接中断");
  assert.equal(f.text(), "Agent：正文\n连接中断\n");
});

async function chatFixture(t) {
  const f = terminalFixture(t);
  const session = { id: THREAD_ID, model: "unit-model", turns: [] };
  const calls = [];
  let listener;
  const api = {
    async request(route, body) {
      calls.push({ route, body });
      if (route === "/messages") return { status: "queued" };
      if (route === "/sessions" || route === "/sessions/resume") return structuredClone(session);
      if (route.startsWith("/sessions?q=")) return { sessions: [{ ...structuredClone(session), preview: "历史会话" }] };
      throw new Error(`未模拟 ${route}`);
    },
    subscribe(id, callback) { listener = callback; return { close() { listener = null; }, resync() { resyncs.push(id); }, done: Promise.resolve() }; }
  };
  const resyncs = [];
  const done = runChat(api, f.terminal);
  t.after(async () => { f.terminal.close(); await done; });
  return { ...f, calls, session, done, resyncs,
    event(type, data) { listener({ type, threadId: session.id, data: structuredClone(data) }); },
    async send(line) { f.input.write(line + "\n"); await new Promise(resolve => setImmediate(resolve)); },
    async start() { f.input.write("你好\n"); await until(() => calls.some(call => call.route === "/messages")); }
  };
}

test("聊天快照去重并拼接，多次事件只显示完整 Thread id / turn id 和一次 Agent 前缀", async t => {
  const f = await chatFixture(t);
  await f.start();
  const turn = { id: TURN_ID, status: "inProgress", answers: {} };
  f.session.turns.push(turn);
  f.event("session", f.session);
  turn.answers.answer = "";
  for (const chunk of ["你", "好", "！", "\n\n", "- 第一", "条"]) {
    turn.answers.answer += chunk;
    f.event("session", f.session);
    f.event("snapshot", { session: f.session, queue: { paused: false, jobs: [] } });
    f.event("queue", { paused: false, jobs: [{ status: "queued" }] });
  }
  turn.status = "completed";
  f.event("session", f.session);
  f.event("session", f.session);
  const output = f.text();
  assert.match(output, /Agent：你好！\n\n- 第一条\n$/);
  assert.equal(output.split(`Thread id: ${THREAD_ID}`).length - 1, 1);
  assert.equal(output.split(`turn id: ${TURN_ID}`).length - 1, 1);
  assert.equal(output.split("Agent：").length - 1, 1);
  assert.doesNotMatch(output, /Agent \[|轮次 |消息已接收|队列：|completed/);
  const { clientMessageId } = f.calls.find(call => call.route === "/messages").body;
  assert.match(clientMessageId, /^[a-f\d-]{36}$/);
  assert.ok(!output.includes(clientMessageId));
});

test("同一个 Thread 的多 turn / 多消息正文分隔正确，失败状态仍可见", async t => {
  const f = await chatFixture(t);
  await f.start();
  f.session.turns = [{ id: TURN_ID, status: "completed", answers: { a: "分析内容", b: "最终回答" } }];
  f.event("session", f.session);
  await f.send("继续");
  const second = { id: "01a0b819-3a46-7a33-b2b5-000000000002", status: "inProgress", answers: { a: "部分回复" } };
  f.session.turns.push(second);
  f.event("session", f.session);
  second.status = "failed";
  second.error = "模型连接断开";
  f.event("session", f.session);
  f.event("session", f.session);
  assert.match(f.text(), new RegExp(`Agent：分析内容\n最终回答\nturn id: ${second.id}\nAgent：部分回复\n状态：failed；模型连接断开\n$`));
  assert.equal(f.calls.filter(call => call.route === "/messages").length, 2);
  assert.equal(f.text().split("Thread id:").length - 1, 1);
});

test("非前缀最终修订有明确提示，不悄悄把全文拼在旧回复后面", async t => {
  const f = await chatFixture(t);
  await f.start();
  const turn = { id: TURN_ID, status: "inProgress", answers: { a: "初始文本" } };
  f.session.turns.push(turn);
  f.event("session", f.session);
  turn.answers.a = "修订文本";
  turn.status = "completed";
  f.event("session", f.session);
  f.event("session", f.session);
  assert.match(f.text(), /Agent：初始文本\n回复已更新：\nAgent：修订文本\n$/);
});

test("/resume 展示和选择完整 Thread id，不需要会话序号", async t => {
  const f = await chatFixture(t);
  await f.send("/resume 历史");
  assert.match(f.text(), new RegExp(`历史会话\nThread id: ${THREAD_ID}`));
  assert.doesNotMatch(f.text(), /1\. |输入编号/);
  await f.send("1");
  assert.equal(f.calls.filter(call => call.route === "/sessions/resume").length, 0);
  await f.send(THREAD_ID);
  assert.deepEqual(f.calls.find(call => call.route === "/sessions/resume").body, { threadId: THREAD_ID });
  assert.equal(f.calls.filter(call => call.route === "/messages").length, 0);
});

test("队列暂停只提示一次，普通队列变化不再逐条刷日志", async t => {
  const f = await chatFixture(t);
  await f.start();
  f.event("queue", { paused: false, jobs: [] });
  f.event("queue", { paused: true, jobs: [] });
  f.event("snapshot", { session: f.session, queue: { paused: true, jobs: [] } });
  assert.equal(f.text().split("队列已暂停").length - 1, 1);
  assert.doesNotMatch(f.text(), /队列：/);
});

test("工具状态变化只显示一次，不泄露工具 callId，不拆碎流式回复", async t => {
  const f = await chatFixture(t);
  await f.start();
  const turn = { id: TURN_ID, status: "inProgress", answers: {}, tools: { secretCallId: { name: "search_web", label: "网页搜索", status: "inProgress" } } };
  f.session.turns.push(turn);
  f.event("session", f.session); f.event("session", f.session);
  turn.tools.secretCallId.status = "failed"; turn.tools.secretCallId.error = "Google 暂时不可用";
  f.event("session", f.session); f.event("session", f.session);
  turn.answers.a = "请提供"; f.event("session", f.session);
  turn.answers.a += "文章链接。"; turn.status = "completed"; f.event("session", f.session);
  assert.equal(f.text().split("工具：网页搜索 · 执行中").length - 1, 1);
  assert.equal(f.text().split("工具：网页搜索 · 失败").length - 1, 1);
  assert.match(f.text(), /Agent：请提供文章链接。\n$/);
  assert.doesNotMatch(f.text(), /secretCallId/);
});

test("协议 v2：turn / delta 事件与完整快照渲染一致，增量接不上时重新同步", async t => {
  const f = await chatFixture(t);
  await f.start();
  const delta = (offset, text) => f.event("delta", { turnId: TURN_ID, itemId: "a", offset, text });
  f.event("turn", { activeTurnId: TURN_ID, turn: { id: TURN_ID, status: "inProgress", answers: {}, tools: {} } });
  delta(0, "你好"); delta(2, "！\n\n- 第一"); delta(2, "！"); delta(9, "条");
  assert.match(f.text(), /Agent：你好！\n\n- 第一条$/, "增量到达即输出，重叠部分不重复");
  f.event("turn", { activeTurnId: null, turn: { id: TURN_ID, status: "completed", answers: { a: "你好！\n\n- 第一条" }, tools: {} } });
  assert.match(f.text(), /Agent：你好！\n\n- 第一条\n$/);
  assert.equal(f.text().split("Agent：").length - 1, 1, "重叠的补发增量不能重复输出");
  assert.deepEqual(f.resyncs, []);
  delta(99, "跳号");
  assert.deepEqual(f.resyncs, [THREAD_ID]);
  assert.doesNotMatch(f.text(), /跳号/);
});
