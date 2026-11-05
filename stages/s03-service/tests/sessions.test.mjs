import test from "node:test";
import assert from "node:assert/strict";
import { rig } from "./helpers.mjs";
import { AGENT_INSTRUCTIONS } from "../server/modules/role/index.mjs";

const starts = r => r.rpc.calls.filter(call => call.method === "turn/start");

test("服务端替客户端发起一轮：立即返回 turn id，结果随通知写进会话快照", async t => {
  const r = await rig(t);
  const accepted = await r.sessions.startTurn(r.session.id, "  你好  ");
  assert.deepEqual(accepted, { threadId: r.session.id, turnId: "turn-1", status: "inProgress" });
  assert.equal(starts(r)[0].params.input[0].text, "你好");
  assert.equal(r.sessions.snapshot(r.session.id).activeTurnId, "turn-1");
  r.rpc.finish(r.session.id);
  const snapshot = r.sessions.snapshot(r.session.id);
  assert.equal(snapshot.activeTurnId, null);
  assert.equal(snapshot.turns[0].status, "completed");
  assert.equal(snapshot.turns[0].answers["answer-turn-1"], "reply-turn-1");
});

test("同一会话一次只跑一轮：上一轮没结束就拒绝，不在服务端排队", async t => {
  const r = await rig(t);
  await r.sessions.startTurn(r.session.id, "A");
  await assert.rejects(r.sessions.startTurn(r.session.id, "B"), error => error.status === 409 && /上一轮还在执行/.test(error.message));
  // 并发提交也只会有一个真正发出 turn/start。
  r.rpc.finish(r.session.id);
  const results = await Promise.allSettled([r.sessions.startTurn(r.session.id, "C"), r.sessions.startTurn(r.session.id, "D")]);
  assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(starts(r).length, 2);
  r.rpc.finish(r.session.id);
  await r.sessions.startTurn(r.session.id, "E");
  assert.equal(starts(r).length, 3);
});

test("完成通知早于 turn/start 响应时，不会把这一轮改回执行中", async t => {
  const r = await rig(t); r.rpc.mode = "early";
  const accepted = await r.sessions.startTurn(r.session.id, "A");
  assert.equal(accepted.status, "completed");
  assert.equal(r.sessions.snapshot(r.session.id).activeTurnId, null);
});

test("新建会话固定只读沙箱、不审批，角色由服务端提供", async t => {
  const r = await rig(t);
  const start = r.rpc.calls.find(call => call.method === "thread/start").params;
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.baseInstructions, AGENT_INSTRUCTIONS);
  assert.equal(start.cwd, r.runtime.workspaceDir);
  await assert.rejects(r.sessions.startTurn(r.session.id, "   "), /不能为空/);
  await assert.rejects(r.sessions.startTurn("../other", "A"), /格式不正确/);
  assert.equal(starts(r).length, 0);
});
