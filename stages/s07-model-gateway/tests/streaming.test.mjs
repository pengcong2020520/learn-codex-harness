import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createLogRedactor } from "../server/modules/config/index.mjs";
import { SessionService } from "../server/modules/sessions/index.mjs";
import { EventHub } from "../server/modules/events/index.mjs";
import { createHttpService } from "../server/modules/http/index.mjs";
import { applySessionEvent } from "../shared/session-events.mjs";
import { AgentClient } from "../client/modules/connection/index.mjs";
import { until } from "./helpers.mjs";

const KEY = "sk-test-secret-key-1234567890";
const DB = "postgresql://agent:pw@127.0.0.1/agent";
const redact = createLogRedactor(KEY, [DB]);

function random(seed) {
  return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
}
function split(text, rand, max = 7) {
  const parts = [];
  for (let at = 0; at < text.length;) {
    const size = 1 + Math.floor(rand() * max);
    parts.push(text.slice(at, at + size));
    at += size;
  }
  return parts;
}

function rig(t, options = {}) {
  const rpc = new EventEmitter();
  rpc.request = async method => { throw new Error(`测试未实现 ${method}`); };
  const hub = new EventHub();
  const sessions = new SessionService({ rpc, config: { launch: {}, root: "/tmp" }, runtime: { workspaceDir: "/tmp" }, hub, redact, ...options });
  t.after(() => sessions.close());
  const events = [];
  hub.on("event", event => events.push(event));
  const notify = (method, params) => rpc.emit("notification", { method, params: { threadId: "t1", ...params } });
  // 按客户端的方式把事件流还原成会话状态。
  const replay = (list = events) => list.reduce((session, event) => {
    const next = applySessionEvent(session, event);
    assert.ok(next, `事件 ${event.sequence} 接不上本地状态`);
    return next;
  }, null);
  const answer = session => session.turns.at(-1)?.answers.a1;
  return { sessions, hub, events, notify, replay, answer };
}

test("滑动窗口：密钥被切在任意位置都不会放行，已放行的文字始终是最终结果的前缀", () => {
  const text = `先看配置：${KEY}，数据库 ${DB}。像密钥开头的词 sk-te 和 postgres 不是密钥。结尾正好是密钥${KEY}`;
  const expected = redact(text);
  for (let seed = 1; seed <= 200; seed++) {
    const stream = redact.stream();
    let released = "";
    for (const part of split(text, random(seed))) {
      released += stream.push(part);
      assert.ok(!released.includes(KEY) && !released.includes(DB), `seed ${seed} 放行了密钥`);
      assert.ok(expected.startsWith(released), `seed ${seed} 放行的文字不是最终结果的前缀`);
    }
    released += stream.end();
    assert.equal(released, expected, `seed ${seed}`);
  }
});

test("滑动窗口：普通文字立即放行，只扣住像密钥开头的末尾", () => {
  const stream = redact.stream();
  assert.equal(stream.push("你好，"), "你好，");
  assert.equal(stream.push("世界。请看 s"), "世界。请看 ");
  assert.equal(stream.push("k-te"), "");
  assert.equal(stream.push("xt 结束"), "sk-text 结束");
  assert.equal(stream.push(KEY.slice(0, 10)), "");
  assert.equal(stream.push(KEY.slice(10)), "[REDACTED]");
  assert.equal(stream.end(), "");
  const unprotected = createLogRedactor("").stream();
  assert.equal(unprotected.push("sk-"), "sk-");
});

test("协议 v2：增量合并成带 offset 的 delta，状态变化只推这一轮", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, events, notify, replay, answer } = rig(t);
  sessions.register({ thread: { id: "t1", turns: [] } });
  assert.deepEqual(events.map(event => event.type), ["session"]);
  notify("turn/started", { turn: { id: "u1", status: "inProgress", items: [] } });
  assert.equal(events.at(-1).type, "turn");
  assert.equal(events.at(-1).data.activeTurnId, "u1");
  for (const delta of ["你", "好", "，", "世界"]) notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta });
  assert.equal(events.length, 2, "增量不应立即推送");
  t.mock.timers.tick(100);
  assert.deepEqual(events.at(-1).data, { turnId: "u1", itemId: "a1", offset: 0, text: "你好，世界" });
  notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta: "！" });
  t.mock.timers.tick(100);
  assert.deepEqual(events.at(-1).data, { turnId: "u1", itemId: "a1", offset: 5, text: "！" });
  notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta: "再见" });
  notify("turn/completed", { turn: { id: "u1", status: "completed", items: [] } });
  assert.deepEqual(events.slice(1).map(event => event.type), ["turn", "delta", "delta", "turn"],
    "终态立即推送这一轮；它已包含尚未推送的文字，不再单独推增量");
  assert.equal(events.at(-1).data.turn.status, "completed");
  assert.equal(events.at(-1).data.activeTurnId, null);
  t.mock.timers.tick(1000);
  assert.equal(events.length, 5, "已取消的定时器不能再推一次");
  assert.equal(answer(replay()), "你好，世界！再见");
  assert.deepEqual(replay(), sessions.snapshot("t1"));
});

test("协议 v2：第一段增量带出新轮次时先推这一轮，客户端不会把增量当成缺口", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, events, notify, replay } = rig(t);
  sessions.register({ thread: { id: "t1", turns: [] } });
  notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta: "早到" });
  notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta: "的增量" });
  t.mock.timers.tick(100);
  assert.deepEqual(events.slice(1).map(event => event.type), ["turn", "delta"]);
  assert.deepEqual(replay(), sessions.snapshot("t1"));
});

test("会话事件：被切开的密钥不出现在任何一次推送里，回复按前缀增长", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, events, notify, replay, answer } = rig(t);
  sessions.register({ thread: { id: "t1", turns: [] } });
  notify("turn/started", { turn: { id: "u1", status: "inProgress", items: [] } });
  const text = `连接串是 ${DB}，密钥是 ${KEY}，请勿外传。`;
  for (const [index, delta] of [...text].entries()) {
    notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta });
    if (index % 3 === 0) t.mock.timers.tick(100);
  }
  // 没有 item/completed 时，轮次结束要放行仍被扣住的尾部。
  notify("turn/completed", { turn: { id: "u1", status: "completed", items: [] } });
  let previous = "";
  for (const [index, event] of events.entries()) {
    const json = JSON.stringify(event);
    assert.ok(!json.includes(KEY) && !json.includes(DB), "推送中出现了密钥");
    assert.ok(!json.includes(KEY.slice(0, 12)) && !json.includes(DB.slice(0, 20)), "推送中出现了密钥的前半截");
    const current = answer(replay(events.slice(0, index + 1))) || "";
    assert.ok(current.startsWith(previous), "回复文字回退了");
    previous = current;
  }
  assert.equal(answer(replay()), redact(text));
});

test("推送量回归：30 轮历史下 1000 段增量，推送字节接近正文本身", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, hub, notify, replay } = rig(t);
  const history = Array.from({ length: 30 }, (_, i) => ({ id: `h${i}`, status: "completed",
    items: [{ type: "agentMessage", id: `m${i}`, text: "x".repeat(5000) }] }));
  sessions.register({ thread: { id: "t1", turns: history } });
  const events = [{ type: "snapshot", data: { session: sessions.snapshot("t1") } }];
  hub.on("event", event => events.push(event));
  const delta = "增量文字增量文字abcdefgh";
  notify("turn/started", { turn: { id: "u1", status: "inProgress", items: [] } });
  for (let i = 0; i < 1000; i++) {
    notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta });
    t.mock.timers.tick(20);
  }
  notify("item/completed", { turnId: "u1", item: { type: "agentMessage", id: "a1", text: delta.repeat(1000) } });
  notify("turn/completed", { turn: { id: "u1", status: "completed", items: [] } });
  const pushed = events.slice(1);
  const bytes = pushed.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
  const body = Buffer.byteLength(delta.repeat(1000));
  t.diagnostic(`协议 v2：${pushed.length} 次，${(bytes / 1024).toFixed(1)} KiB；回复正文 ${(body / 1024).toFixed(1)} KiB。协议 v1 合并推送约 31.7 MiB`);
  assert.ok(pushed.length <= 205, `推送 ${pushed.length} 次`);
  // 正文经 delta 推一遍、item/completed 与 turn/completed 各随整轮带一遍，再加每帧的少量字段。
  assert.ok(bytes < body * 4, `推送 ${bytes} 字节，正文 ${body} 字节`);
  assert.deepEqual(replay(), sessions.snapshot("t1"), "快照加事件流应还原出与服务端一致的会话");
});

test("事件归并：缺口返回 null，重叠只追加新文字，轮次按 id 替换并保留最近 30 轮", () => {
  const base = { id: "t1", turns: [{ id: "u1", status: "inProgress", answers: { a1: "你好" } }] };
  const delta = (offset, text) => ({ type: "delta", threadId: "t1", data: { turnId: "u1", itemId: "a1", offset, text } });
  assert.equal(applySessionEvent(base, delta(3, "界")), null);
  assert.equal(applySessionEvent(base, { ...delta(0, "x"), data: { ...delta(0, "x").data, turnId: "u9" } }), null);
  assert.equal(applySessionEvent(base, delta(0, "你")), base);
  assert.equal(applySessionEvent(base, delta(1, "好，世界")).turns[0].answers.a1, "你好，世界");
  assert.equal(applySessionEvent(base, { ...delta(0, "x"), threadId: "t2" }), base, "其他会话的事件不改动本会话");
  const replaced = applySessionEvent(base, { type: "turn", threadId: "t1", data: { activeTurnId: null, turn: { id: "u1", status: "completed", answers: { a1: "定稿" } } } });
  assert.deepEqual(replaced.turns, [{ id: "u1", status: "completed", answers: { a1: "定稿" } }]);
  assert.equal(replaced.activeTurnId, null);
  let session = { id: "t1", turns: [] };
  for (let i = 0; i < 35; i++) session = applySessionEvent(session, { type: "turn", threadId: "t1", data: { turn: { id: `u${i}`, answers: {} } } });
  assert.deepEqual(session.turns.map(turn => turn.id), Array.from({ length: 30 }, (_, i) => `u${i + 5}`));
  assert.equal(applySessionEvent(null, delta(0, "x")), null, "没有本地状态时只能重新同步");
});

async function service(t, { hub = new EventHub(), redact: encode = redact, messages = { snapshot: async () => ({ jobs: [] }) } } = {}) {
  const http = createHttpService({ config: { port: 0, host: "127.0.0.1" }, token: "token", hub, redact: encode,
    sessions: { ensure: async () => {}, snapshot: id => ({ id, turns: [] }) }, messages });
  const url = await http.listen();
  t.after(() => http.close());
  return url;
}

async function connect(t, url, headers = {}) {
  const response = await fetch(`${url}/events?threadId=t1`, { headers: { authorization: "Bearer token", ...headers } });
  const reader = response.body.getReader();
  let text = "";
  const close = () => reader.cancel().catch(() => {});
  t.after(close);
  return {
    async until(pattern) { while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value); },
    text: () => text,
    frames: () => text.split("\n\n").filter(frame => frame.includes("data: ")).map(frame => {
      const lines = frame.split("\n");
      return { id: lines.find(line => line.startsWith("id: "))?.slice(4) ?? null,
        event: JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6)) };
    }),
    close
  };
}

test("SSE：同一事件推给多个连接时只脱敏、序列化一次", async t => {
  const hub = new EventHub();
  let encodings = 0;
  const url = await service(t, { hub, redact: value => { if (value?.type === "session") encodings++; return redact(value); } });
  const streams = [await connect(t, url), await connect(t, url)];
  for (const stream of streams) await stream.until(/"type":"snapshot"/);
  hub.publish("session", { id: "t1", turns: [], note: `含密钥 ${KEY}` }, "t1");
  for (const stream of streams) await stream.until(/"type":"session"/);
  assert.equal(encodings, 1);
  for (const stream of streams) assert.ok(!stream.text().includes(KEY));
});

test("SSE：事件带编号，断线重连凭 Last-Event-ID 只补发错过的本会话事件", async t => {
  const hub = new EventHub({ history: 4 });
  const url = await service(t, { hub });
  const first = await connect(t, url);
  await first.until(/"type":"snapshot"/);
  hub.publish("turn", { turn: { id: "u1", answers: {} } }, "t1");
  hub.publish("turn", { turn: { id: "x1", answers: {} } }, "t2");
  hub.publish("delta", { turnId: "u1", itemId: "a1", offset: 0, text: "甲" }, "t1");
  await first.until(/"甲"/);
  const frames = first.frames();
  assert.deepEqual(frames.map(frame => frame.event.type), ["snapshot", "turn", "delta"], "其他会话的事件不推给本连接");
  assert.deepEqual(frames.map(frame => frame.id), [`${hub.epoch}-0`, `${hub.epoch}-1`, `${hub.epoch}-3`]);
  await first.close();
  hub.publish("delta", { turnId: "u1", itemId: "a1", offset: 1, text: "乙" }, "t1");
  const resumed = await connect(t, url, { "last-event-id": frames.at(-1).id });
  await resumed.until(/"乙"/);
  assert.deepEqual(resumed.frames().map(frame => [frame.id, frame.event.type]), [[`${hub.epoch}-4`, "delta"]], "补发时不再发快照");
  // 编号来自别的进程，或缓冲已经覆盖不到：退回快照。
  for (let i = 0; i < 3; i++) hub.publish("delta", { turnId: "u1", itemId: "a1", offset: 2 + i, text: "丙" }, "t1");
  for (const id of ["ffffffff-3", `${hub.epoch}-1`, `${hub.epoch}-99`, "not-an-id"]) {
    const stream = await connect(t, url, { "last-event-id": id });
    await stream.until(/"type":"snapshot"/);
    assert.equal(stream.frames()[0].id, `${hub.epoch}-7`, id);
    await stream.close();
  }
});

test("SSE：快照之前缓冲的会话事件已含在快照里，不再补发；其他事件补发但不带编号", async t => {
  const hub = new EventHub();
  const url = await service(t, { hub, messages: { snapshot: async () => {
    hub.publish("turn", { turn: { id: "旧轮次", answers: {} } }, "t1");
    hub.publish("queue", { jobs: ["排队中"] }, "t1");
    return { jobs: [] };
  } } });
  const stream = await connect(t, url);
  await stream.until(/排队中/);
  hub.publish("delta", { turnId: "u1", itemId: "a1", offset: 0, text: "新" }, "t1");
  await stream.until(/"新"/);
  assert.deepEqual(stream.frames().map(frame => [frame.id, frame.event.type]),
    [[`${hub.epoch}-2`, "snapshot"], [null, "queue"], [`${hub.epoch}-3`, "delta"]]);
});

test("CLI 订阅：重连带上最后的事件编号，resync() 放弃断点、立即从快照重新开始", async t => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.headers["last-event-id"] ?? null);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (id, event) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
    if (seen.length === 1) response.end(frame("e-1", { type: "snapshot" }));
    else if (seen.length === 2) response.write(frame("e-2", { type: "delta" }) + frame("e-3", { type: "queue" }));
    else response.write(frame("e-9", { type: "snapshot" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = new AgentClient({ url: `http://127.0.0.1:${server.address().port}`, token: "token" });
  const events = [];
  const subscription = client.subscribe("t1", event => {
    events.push(event.type);
    if (event.type === "delta") subscription.resync();
  });
  await until(() => events.length === 3, 5000);
  subscription.close(); await subscription.done;
  assert.deepEqual(seen, [null, "e-1", null]);
  assert.deepEqual(events, ["snapshot", "delta", "snapshot"], "resync 之后同一帧批次里剩下的事件不再处理");
});
