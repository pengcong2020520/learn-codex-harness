import test from "node:test";
import assert from "node:assert/strict";
import { rig, until } from "./helpers.mjs";
import { TestJobs } from './jobs-fixture.mjs';
import { MessageService } from "../server/modules/messages/index.mjs";

test("普通消息由服务端 FIFO；提交不等待模型；每条是不同 turn", async t => {
  const r = await rig(t);
  await r.submit("A", "a"); await r.submit("B", "b"); await r.submit("C", "c");
  await until(() => r.messages.job("a").status === "running");
  assert.equal(r.messages.job("b").status, "queued");
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 1);
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job("b").status === "running");
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job("c").status === "running");
  r.rpc.finish(r.session.id);
  assert.equal(new Set(["a","b","c"].map(id => r.messages.job(id).turnId)).size, 3);
  assert.deepEqual(r.rpc.calls.filter(call => call.method === "turn/start").map(call => call.params.input[0].text), ["A","B","C"]);
});

test("显式追加绑定活动 turn；普通自然语言不会触发 steer", async t => {
  const r = await rig(t);
  await r.submit("A", "a"); await until(() => r.messages.job("a").status === "running");
  const turnId = r.messages.job("a").turnId;
  await r.submit("接着之前那个要求做", "b");
  await r.submit("补充", "append", "append", turnId);
  await until(() => r.messages.job('append').status === 'running');
  assert.equal(r.messages.job("append").turnId, turnId);
  assert.equal(r.messages.job("b").status, "queued");
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/steer").length, 1);
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job('append').status === 'completed');
  assert.equal(r.messages.job("append").status, "completed");
  await until(() => r.messages.job("b").status === "running");
});

test("追加到达时目标刚结束：自动接续，先于 B/C，不需要再次确认", async t => {
  const r = await rig(t);
  await r.submit("A", "a"); await until(() => r.messages.job("a").status === "running");
  const turnId = r.messages.job("a").turnId;
  await r.submit("B", "b"); await r.submit("C", "c");
  r.rpc.mode = "end-before-steer";
  await r.submit("A 的补充", "append", "append", turnId);
  await until(() => r.messages.job('append').status !== 'queued' || r.sessions.getTurn(r.session.id, turnId).status === 'completed');
  r.rpc.mode = "normal";
  await until(() => r.messages.job("append").status === "running");
  assert.notEqual(r.messages.job("append").turnId, turnId);
  assert.equal(r.messages.job("b").status, "queued");
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job("b").status === "running");
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job("c").status === "running");
});

test("B 已实际启动时，补充 A 不误投 B、不自动打断 B，接续优先于尚未启动的 C", async t => {
  const r = await rig(t);
  await r.submit("A", "a"); await until(() => r.messages.job("a").status === "running");
  const turnId = r.messages.job("a").turnId;
  await r.submit("B", "b"); await r.submit("C", "c"); r.rpc.finish(r.session.id);
  await until(() => r.messages.job("b").status === "running");
  await r.submit("A 的补充", "append", "append", turnId);
  assert.ok(!r.rpc.calls.some(call => ["turn/steer", "turn/interrupt"].includes(call.method)));
  assert.deepEqual((await r.messages.snapshot(r.session.id)).jobs.filter(job => job.status === "queued").map(job => job.id), ["append", "c"]);
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job("append").status === "running");
  assert.equal(r.messages.job("c").status, "queued");
});

test("通知先于响应仍正确结束，不将 completed 回填为 inProgress", async t => {
  const r = await rig(t); r.rpc.mode = "early";
  await r.submit("A", "a"); await r.submit("B", "b");
  await until(() => r.messages.job("b").status === "completed");
  assert.equal(r.messages.job("a").status, "completed");
  assert.equal(r.sessions.snapshot(r.session.id).activeTurnId, null);
});

test("同消息 ID 重复提交不重复执行；不同内容返回冲突", async t => {
  const r = await rig(t);
  await Promise.all([r.submit("A", "same"), r.submit("A", "same")]);
  await until(() => r.messages.job("same").status === "running");
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 1);
  await assert.rejects(r.submit("changed", "same"), /不同的消息/);
});

test("追加超时或其他拒绝不自动新开 turn，防止重复执行", async t => {
  for (const mode of ["uncertain-steer", "denied-steer"]) {
    const r = await rig(t);
    await r.submit("A", "a"); await until(() => r.messages.job("a").status === "running");
    r.rpc.mode = mode;
    await r.submit("补充", "append", "append", r.messages.job("a").turnId);
    await until(() => ['failed','unconfirmed'].includes(r.messages.job('append').status));
    assert.equal(r.messages.job("append").status, mode === "uncertain-steer" ? "unconfirmed" : "failed");
    assert.equal((await r.messages.snapshot(r.session.id)).paused, true);
    assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 1);
  }
});

// 记录权限门禁的开启与结束。
function recordGate(r, start = () => {}) {
  const calls = [];
  r.messages.gate = { submission: () => null, start: job => { calls.push(["start", job.id]); start(); }, end: (threadId, turnId) => calls.push(["end", threadId, turnId ?? null]), close() {} };
  return calls;
}

test("追加失败不结束正在运行轮次的权限门禁", async t => {
  for (const mode of ["uncertain-steer", "denied-steer"]) {
    const r = await rig(t); const gate = recordGate(r);
    await r.submit("A", "a"); await until(() => r.messages.job("a").status === "running");
    r.rpc.mode = mode;
    await r.submit("补充", "append", "append", r.messages.job("a").turnId);
    await until(() => ["failed", "unconfirmed"].includes(r.messages.job("append").status));
    assert.deepEqual(gate, [["start", "a"]], `${mode}：追加没有开启新的上下文，也不能结束任务 a 的`);
    assert.equal(r.messages.job("a").status, "running");
  }
});

test("新任务发出后失败才结束它自己开启的权限门禁；门禁拒绝开启时不结束会话里已有的", async t => {
  const r = await rig(t); const gate = recordGate(r);
  r.rpc.mode = "uncertain-start";
  await r.submit("A", "a"); await until(() => r.messages.job("a").status === "unconfirmed");
  assert.deepEqual(gate, [["start", "a"], ["end", r.session.id, null]]);

  const denied = await rig(t);
  const calls = recordGate(denied, () => { throw new Error("该会话已有运行中的任务。"); });
  await denied.submit("B", "b"); await until(() => denied.messages.job("b").status === "failed");
  assert.deepEqual(calls, [["start", "b"]]);
  assert.ok(!denied.rpc.calls.some(call => call.method === "turn/start"));
});

test("不同 thread 的事件和执行互相隔离", async t => {
  const r = await rig(t); const second = await r.sessions.create();
  await r.submit("A", "a"); await r.submit("B", "b", "enqueue", null, second.id);
  await until(() => r.messages.job("a").status === "running" && r.messages.job("b").status === "running");
  r.rpc.finish(r.session.id);
  await until(() => r.messages.job('a').status === 'completed');
  assert.equal(r.messages.job("a").status, "completed");
  assert.equal(r.messages.job("b").status, "running");
  assert.equal(r.sessions.snapshot(second.id).activeTurnId, r.messages.job("b").turnId);
});

test("失败后暂停队列；明确 continue 才处理下一条，不重跑失败项", async t => {
  const r = await rig(t);
  await r.submit("A", "a"); await r.submit("B", "b"); await until(() => r.messages.job("a").status === "running");
  r.rpc.finish(r.session.id, "failed");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(r.messages.job("b").status, "queued");
  await r.messages.continue(r.session.id);
  await until(() => r.messages.job("b").status === "running");
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 2);
});

test("服务重启保留排队项，未确认执行不自动重发", async t => {
  const r = await rig(t);
  await r.submit("A", "a"); await r.submit("B", "b"); await until(() => r.messages.job("a").status === "running");
  await r.messages.close();
  const restored = await new MessageService({ ...r, store: new TestJobs(structuredClone(r.messages.store.state)) }).open();
  r.cleanup(() => restored.close());
  assert.equal(restored.job("a").status, "unconfirmed");
  assert.equal(restored.job("b").status, "queued");
  assert.equal((await restored.snapshot(r.session.id)).paused, true);
});

test('迟到的响应不能把 unconfirmed 重新改成 running 或触发重发', async t => {
  const r = await rig(t); r.rpc.mode = 'uncertain-start';
  await r.submit('A', 'uncertain');
  await until(() => r.messages.job('uncertain').status === 'unconfirmed');
  await r.messages.bind('uncertain', 'turn-1');
  assert.equal(r.messages.job('uncertain').status, 'unconfirmed');
  assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});
