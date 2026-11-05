import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_TURN_MEMORY } from "../server/modules/sessions/index.mjs";
import { SESSION_TURN_LIMIT } from "../shared/session-events.mjs";
import { rig } from "./helpers.mjs";

const ids = (from, to) => Array.from({ length: to - from }, (_, i) => `turn-${String(from + i).padStart(4, "0")}`);
const completed = (r, list) => { for (const id of list) r.sessions.recordTurn(r.session.id, { id, status: "completed", items: [] }); };

test("会话内存只保留最近的轮次：长会话不会无限增长，快照与定位不受影响", async t => {
  assert.ok(SESSION_TURN_MEMORY >= SESSION_TURN_LIMIT);
  const r = await rig(t), total = SESSION_TURN_MEMORY + 50, all = ids(0, total);
  completed(r, all);
  const turns = r.sessions.sessions.get(r.session.id).turns;
  assert.equal(turns.size, SESSION_TURN_MEMORY);
  assert.deepEqual([...turns.keys()], all.slice(-SESSION_TURN_MEMORY), "丢掉的是最早的轮次");
  assert.equal(r.sessions.getTurn(r.session.id, all[0]), undefined);
  const snapshot = r.sessions.snapshot(r.session.id);
  assert.equal(snapshot.lastTurnId, all.at(-1));
  assert.deepEqual(snapshot.turns.map(turn => turn.id), all.slice(-SESSION_TURN_LIMIT));
});

test("执行中的轮次不会被丢掉：工具请求与完成事件仍能找到它", async t => {
  const r = await rig(t);
  r.sessions.recordTurn(r.session.id, { id: "running", status: "inProgress", items: [] });
  completed(r, ids(0, SESSION_TURN_MEMORY + 20));
  const session = r.sessions.sessions.get(r.session.id);
  assert.equal(session.turns.size, SESSION_TURN_MEMORY);
  assert.equal(r.sessions.getTurn(r.session.id, "running")?.status, "inProgress");
  assert.equal(session.activeTurnId, "running");
  r.rpc.notify("item/completed", { threadId: r.session.id, turnId: "running",
    item: { id: "tool", type: "dynamicToolCall", tool: "read_file", status: "completed" } });
  assert.equal(r.sessions.getTurn(r.session.id, "running").tools.tool.status, "completed");
  r.rpc.notify("turn/completed", { threadId: r.session.id, turn: { id: "running", status: "completed", items: [] } });
  assert.equal(session.activeTurnId, null);
  completed(r, ["one-more"]);
  assert.equal(r.sessions.getTurn(r.session.id, "running"), undefined, "完成后按顺序可以被丢掉");
});

test("恢复很长的历史会话时同样只载入最近的轮次", async t => {
  const r = await rig(t), history = ids(0, SESSION_TURN_MEMORY * 3);
  const snapshot = r.sessions.register({ thread: { id: "long-thread", cwd: r.runtime.workspaceDir, name: "长会话", turns: history.map(id => ({ id, status: "completed", items: [] })) }, model: "unit-model", modelProvider: "project_api" });
  assert.equal(r.sessions.sessions.get("long-thread").turns.size, SESSION_TURN_MEMORY);
  assert.equal(snapshot.lastTurnId, history.at(-1));
  assert.equal(snapshot.turns.length, SESSION_TURN_LIMIT);
  r.rpc.notify("item/agentMessage/delta", { threadId: "long-thread", turnId: history[0], itemId: "old-answer", delta: "迟到" });
  assert.equal(r.sessions.getTurn("long-thread", history[0]), undefined);
  assert.deepEqual(r.sessions.snapshot("long-thread"), snapshot);
});

test("追加到已移出内存的旧轮次时明确拒绝，不会误追加到别的轮次", async t => {
  const r = await rig(t), all = ids(0, SESSION_TURN_MEMORY + 1);
  completed(r, all);
  await assert.rejects(r.submit("补充", "late-append", "append", all[0]), /追加目标不属于该会话或尚不可定位/);
  assert.ok(!r.rpc.calls.some(call => ["turn/start", "turn/steer"].includes(call.method)));
});

test("activeTurnId 保护的轮次与所有执行中轮次都保留，即使暂时超过上限", async t => {
  const r = await rig(t), session = r.sessions.sessions.get(r.session.id);
  completed(r, ["active"]);
  session.activeTurnId = "active";
  completed(r, ids(0, SESSION_TURN_MEMORY + 1));
  assert.ok(r.sessions.getTurn(r.session.id, "active"));
  assert.equal(session.turns.size, SESSION_TURN_MEMORY);
  session.activeTurnId = null;
  completed(r, ["next"]);
  assert.equal(r.sessions.getTurn(r.session.id, "active"), undefined);

  const running = ids(1000, 1000 + SESSION_TURN_MEMORY + 1);
  for (const id of running) r.sessions.recordTurn(r.session.id, { id, status: "inProgress" });
  assert.deepEqual([...session.turns.keys()], running);
  for (const id of running) r.sessions.recordTurn(r.session.id, { id, status: "completed" });
  completed(r, ["after-running"]);
  assert.equal(session.turns.size, SESSION_TURN_MEMORY);
  assert.equal(session.activeTurnId, null);
});

test("被移除轮次的迟到通知与 RPC 响应不会重建轮次、推送或改变定位", async t => {
  const r = await rig(t), all = ids(0, SESSION_TURN_MEMORY * 3);
  completed(r, all);
  const before = r.sessions.snapshot(r.session.id), published = [], finished = [];
  r.hub.publish = (...event) => published.push(event);
  r.sessions.on("turnCompleted", event => finished.push(event));
  // 同时检查最早和刚移除的轮次，ID 不依赖字典序或时间戳。
  for (const id of [all[0], all.at(-SESSION_TURN_MEMORY - 1)]) {
    const params = { threadId: r.session.id, turnId: id };
    for (const method of ["item/agentMessage/delta", "item/started", "item/completed", "turn/started", "turn/completed"]) {
      assert.doesNotThrow(() => r.rpc.notify(method, { ...params, itemId: "late-answer", delta: "迟到",
        item: { id: "late-answer", type: "agentMessage", text: "迟到" },
        turn: { id, status: method === "turn/started" ? "inProgress" : "completed", items: [] } }));
    }
    assert.equal(r.sessions.recordTurn(r.session.id, { id, status: "inProgress", items: [] }), undefined);
    assert.equal(r.sessions.getTurn(r.session.id, id), undefined);
  }
  assert.deepEqual(r.sessions.snapshot(r.session.id), before);
  assert.equal(r.sessions.sessions.get(r.session.id).turns.size, SESSION_TURN_MEMORY);
  assert.deepEqual(published, []);
  assert.deepEqual(finished, []);
});

test("新轮次的早到增量和早到完成仍生效，晚到的开始响应不能重置状态", async t => {
  const r = await rig(t), threadId = r.session.id;
  completed(r, ids(0, SESSION_TURN_MEMORY + 1));
  r.rpc.notify("item/agentMessage/delta", { threadId, turnId: "new-turn", itemId: "answer", delta: "新回复" });
  r.rpc.notify("turn/completed", { threadId, turn: { id: "new-turn", status: "completed", items: [] } });
  r.sessions.recordTurn(threadId, { id: "new-turn", status: "inProgress", items: [] });
  assert.equal(r.sessions.getTurn(threadId, "new-turn").status, "completed");
  assert.equal(r.sessions.getTurn(threadId, "new-turn").answers.answer, "新回复");
  assert.equal(r.sessions.snapshot(threadId).lastTurnId, "new-turn");
  assert.equal(r.sessions.snapshot(threadId).activeTurnId, null);
});
