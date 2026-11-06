import test from "node:test";
import assert from "node:assert/strict";
import { rig, until } from "./helpers.mjs";
import { AGENT_INSTRUCTIONS } from "../server/modules/role/index.mjs";

test("新建会话固定只读沙箱、不审批，角色由服务端提供", async t => {
  const r = await rig(t);
  const start = r.rpc.calls.find(call => call.method === "thread/start").params;
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.baseInstructions, AGENT_INSTRUCTIONS);
  assert.equal(start.cwd, r.runtime.workspaceDir);
});

test("会话快照变化都经事件中心发布，只带本会话的 Thread id", async t => {
  const r = await rig(t), events = [];
  r.hub.on("event", event => events.push(event));
  await r.submit("A", "a");
  await until(() => r.messages.job("a").status === "running");
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job("a").status === "completed");
  assert.ok(events.some(event => event.type === "session" && event.data.turns.some(turn => turn.status === "completed")));
  assert.ok(events.some(event => event.type === "queue"));
  assert.ok(events.every(event => event.threadId === r.session.id));
  assert.deepEqual(events.map(event => event.sequence), [...events.map(event => event.sequence)].sort((a, b) => a - b), "事件序号单调递增");
});
