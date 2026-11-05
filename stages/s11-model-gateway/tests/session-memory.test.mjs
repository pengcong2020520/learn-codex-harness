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
  r.sessions.recordTurn(r.session.id, { id: "running", status: "completed", items: [] });
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
});

test("追加到已移出内存的旧轮次时明确拒绝，不会误追加到别的轮次", async t => {
  const r = await rig(t), all = ids(0, SESSION_TURN_MEMORY + 1);
  completed(r, all);
  await assert.rejects(r.submit("补充", "late-append", "append", all[0]), /追加目标不属于该会话或尚不可定位/);
  assert.ok(!r.rpc.calls.some(call => ["turn/start", "turn/steer"].includes(call.method)));
});
