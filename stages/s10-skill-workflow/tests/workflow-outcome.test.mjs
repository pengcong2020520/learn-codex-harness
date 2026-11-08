import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MessageService } from "../server/modules/messages/index.mjs";
import { checksPassed } from "../server/modules/workflows/index.mjs";
import { TestJobs } from "./jobs-fixture.mjs";

function rig(t, workflow = { id: "report", checks: ["format", "sources-cited"], steps: null }) {
  const turn = { id: "turn", status: "completed", artifacts: { a: { format: "md", sources: 1 } } };
  const job = { id: "job", threadId: "thread", turnId: turn.id, mode: "enqueue", status: "running", workflow: "report", text: "报告", step: 0 };
  const store = new TestJobs({ jobs: [job], paused: [] });
  const sessions = Object.assign(new EventEmitter(), { getTurn: () => turn, sessions: new Map() });
  const messages = new MessageService({ rpc: new EventEmitter(), sessions, store, queue: {}, hub: { publish() {} },
    config: { agent: { workflows: { resolve: () => workflow }, outputs: { formats: ["md"] } } } });
  const wake = t.mock.method(store, "wake");
  return { messages, store, job, turn, workflow, wake };
}

for (const path of ["bind", "completed"]) {
  test(`验收异常：${path} 保存 resolve 抛错原因，不暂停队列、不重试`, async t => {
    const r = rig(t);
    t.mock.method(r.messages, "resolve", () => { throw new Error("Agent 已撤销该 Workflow"); });
    assert.deepEqual(r.messages.outcome(r.job, r.turn), {
      status: "needs-review", checks: null, error: "Workflow 验收未完成：Agent 已撤销该 Workflow",
    });
    if (path === "bind") {
      r.job.status = "starting";
      r.job.turnId = null;
      await r.messages.bind(r.job.id, r.turn.id);
    } else await r.messages.completed(r.job.threadId, r.turn);
    assert.equal(r.store.get(r.job.id).status, "needs-review");
    assert.equal(r.store.get(r.job.id).error, "Workflow 验收未完成：Agent 已撤销该 Workflow");
    assert.equal(r.store.paused(r.job.threadId), false);
    assert.equal(r.wake.mock.callCount(), 1, "仍然唤醒队列");
    assert.equal(r.job.step, 0, "不进入下一步或重新排队");
    assert.equal(r.messages.failure, null);
  });
}

test("验收异常：stepOf 和 runChecks 抛错都需要核对", t => {
  const r = rig(t, { id: "report", steps: [] });
  assert.deepEqual(r.messages.outcome(r.job, r.turn), {
    status: "needs-review", checks: null, error: "Workflow 验收未完成：Workflow report 没有第 1 步。",
  });
  r.workflow.steps = null;
  r.workflow.checks = ["format"];
  Object.defineProperty(r.turn, "artifacts", { get() { throw new Error("产物不可读取"); } });
  assert.deepEqual(r.messages.outcome(r.job, r.turn), {
    status: "needs-review", checks: null, error: "Workflow 验收未完成：产物不可读取",
  });
});

test("声明检查必须全部出现：结果缺一项、为空或缺失均不能完成", t => {
  const r = rig(t);
  for (const results of [[{ id: "format", passed: true }], [], null, undefined]) {
    // 只替换这个声明数组的 map，模拟检查执行器遗漏结果，不改全局 Array 或生产注入接口。
    r.workflow.checks.map = () => results;
    assert.deepEqual(r.messages.outcome(r.job, r.turn), { status: "needs-review", checks: results });
    delete r.workflow.checks.map;
  }
});

test("声明检查全部通过才 completed；无声明、非完成轮次和 append 保持既有语义", t => {
  const r = rig(t);
  const result = r.messages.outcome(r.job, r.turn);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.checks.map(check => [check.id, check.passed]), [["format", true], ["sources-cited", true]]);
  r.workflow.checks = [];
  assert.deepEqual(r.messages.outcome(r.job, r.turn), { status: "completed", checks: null });
  t.mock.method(r.messages, "resolve", () => { throw new Error("不应解析"); });
  assert.deepEqual(r.messages.outcome(r.job, { status: "failed" }), { status: "failed", checks: null });
  assert.deepEqual(r.messages.outcome({ ...r.job, mode: "append" }, r.turn), { status: "completed", checks: null });
});

test("checksPassed 按 ID 匹配并要求严格 true，空声明可通过", () => {
  assert.equal(checksPassed([], null), true);
  assert.equal(checksPassed(["a", "b"], [{ id: "b", passed: true }, { id: "a", passed: true }]), true);
  for (const results of [null, undefined, [], [{ id: "a", passed: true }], [{ id: "x", passed: true }],
    [{ id: "a", passed: 1 }], [{ id: "a", passed: "true" }], [{ id: "a", passed: false }],
    [{ id: "a", passed: true }, { id: "extra", passed: false }]]) {
    assert.equal(checksPassed(["a", "b"], results), false);
  }
  assert.equal(checksPassed(["a"], [{ id: "a", passed: 1 }]), false);
  assert.equal(checksPassed(["a"], [{ id: "a", passed: true }, { id: "extra", passed: false }]), false);
});
