import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLogRedactor } from "../server/modules/config/index.mjs";
import { SessionService } from "../server/modules/sessions/index.mjs";
import { EventHub } from "../server/modules/events/index.mjs";
import { createHttpService } from "../server/modules/http/index.mjs";

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
  const answer = (event = events.at(-1)) => event.data.turns.at(-1).answers.a1;
  return { sessions, hub, events, notify, answer };
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

test("合并推送：同一周期的多段增量只推一次，状态变化立即推送并取消待推送", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, events, notify, answer } = rig(t);
  sessions.register({ thread: { id: "t1", turns: [] } });
  events.length = 0;
  notify("turn/started", { turn: { id: "u1", status: "inProgress", items: [] } });
  assert.equal(events.length, 1);
  for (const delta of ["你", "好", "，", "世界"]) notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta });
  assert.equal(events.length, 1, "增量不应立即推送");
  t.mock.timers.tick(100);
  assert.equal(events.length, 2);
  assert.equal(answer(), "你好，世界");
  notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta: "！" });
  notify("turn/completed", { turn: { id: "u1", status: "completed", items: [] } });
  assert.equal(events.length, 3, "终态立即推送，并带上尚未推送的增量");
  assert.equal(answer(), "你好，世界！");
  assert.equal(events.at(-1).data.turns.at(-1).status, "completed");
  t.mock.timers.tick(1000);
  assert.equal(events.length, 3, "已取消的定时器不能再推一次旧状态");
});

test("会话快照：被切开的密钥不出现在任何一次推送里，回复按前缀增长", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, events, notify, answer } = rig(t);
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
  for (const event of events.filter(event => event.data.turns.length)) {
    const json = JSON.stringify(event);
    assert.ok(!json.includes(KEY) && !json.includes(DB), "推送中出现了密钥");
    // 旧实现会把输出到一半的密钥原样推出去：只差最后几个字符时，整段替换匹配不上。
    assert.ok(!json.includes(KEY.slice(0, 12)) && !json.includes(DB.slice(0, 20)), "推送中出现了密钥的前半截");
    const current = answer(event) || "";
    assert.ok(current.startsWith(previous), "回复文字回退了");
    previous = current;
  }
  assert.equal(answer(), redact(text));
});

test("推送量回归：30 轮历史下 1000 段增量（每 20ms 一段）", t => {
  const measure = publishInterval => {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { sessions, hub, notify } = rig(t, { publishInterval });
    const history = Array.from({ length: 30 }, (_, i) => ({ id: `h${i}`, status: "completed",
      items: [{ type: "agentMessage", id: `m${i}`, text: "x".repeat(5000) }] }));
    sessions.register({ thread: { id: "t1", turns: history } });
    let count = 0, bytes = 0;
    hub.on("event", event => { count++; bytes += Buffer.byteLength(JSON.stringify(event)); });
    notify("turn/started", { turn: { id: "u1", status: "inProgress", items: [] } });
    for (let i = 0; i < 1000; i++) {
      notify("item/agentMessage/delta", { turnId: "u1", itemId: "a1", delta: "增量文字增量文字abcdefgh" });
      t.mock.timers.tick(20);
    }
    notify("turn/completed", { turn: { id: "u1", status: "completed", items: [] } });
    sessions.close();
    return { count, bytes };
  };
  const everyDelta = measure(0);
  const merged = measure(100);
  const mib = bytes => (bytes / 1048576).toFixed(1);
  t.diagnostic(`逐段推送：${everyDelta.count} 次，${mib(everyDelta.bytes)} MiB；合并推送：${merged.count} 次，${mib(merged.bytes)} MiB`);
  assert.ok(merged.count <= 205, `合并后仍推送 ${merged.count} 次`);
  assert.ok(merged.bytes * 4 < everyDelta.bytes, "合并推送应至少减少四分之三的字节");
});

test("SSE：同一事件推给多个连接时只脱敏、序列化一次", async t => {
  const hub = new EventHub();
  let encodings = 0;
  const counting = value => { if (value?.type === "session") encodings++; return redact(value); };
  const http = createHttpService({ config: { port: 0, host: "127.0.0.1" }, token: "token", hub, redact: counting,
    sessions: { ensure: async () => {}, snapshot: id => ({ id, turns: [] }) },
    messages: { snapshot: async () => ({ jobs: [] }) } });
  const url = await http.listen();
  t.after(() => http.close());
  const open = async () => {
    const response = await fetch(`${url}/events?threadId=t1`, { headers: { authorization: "Bearer token" } });
    const reader = response.body.getReader();
    let text = "";
    const until = async pattern => {
      while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    t.after(() => reader.cancel());
    return { until, text: () => text };
  };
  const streams = [await open(), await open()];
  for (const stream of streams) await stream.until(/"type":"snapshot"/);
  hub.publish("session", { id: "t1", turns: [], note: `含密钥 ${KEY}` }, "t1");
  for (const stream of streams) await stream.until(/"type":"session"/);
  assert.equal(encodings, 1);
  for (const stream of streams) assert.ok(!stream.text().includes(KEY));
});
