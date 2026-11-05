// 需要先 npm run server。本脚本明确调用真实模型，会产生对应 API 用量。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentClient, loadClientConnection } from "../client/modules/connection/index.mjs";

const api = new AgentClient(loadClientConnection());
const session = await api.request("/sessions", {});
console.log(`验证会话：${session.id}`);
const word = "木星钟摆";
const first = randomUUID(), second = randomUUID();
await api.request("/messages", { threadId: session.id, clientMessageId: first, text: `这是脚手架验证。请记住测试词：${word}。不要调用工具，只回复：已记住。` });
await api.request("/messages", { threadId: session.id, clientMessageId: second, text: "上一条消息让我记住的测试词是什么？不要调用工具，只回复测试词。" });
const deadline = Date.now() + 180000;
let state;
while (Date.now() < deadline) {
  state = await api.request(`/state?threadId=${session.id}`);
  const jobs = state.queue.jobs.filter(job => [first, second].includes(job.id));
  if (jobs.some(job => ["failed", "interrupted", "unconfirmed"].includes(job.status))) throw new Error("真实模型调用未完成，请查看 /queue 和服务端协议日志。");
  if (jobs.length === 2 && jobs.every(job => job.status === "completed")) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
const jobs = state.queue.jobs.filter(job => [first, second].includes(job.id));
assert.ok(jobs.every(job => job.status === "completed"), "等待真实模型回复超时");
assert.notEqual(jobs[0].turnId, jobs[1].turnId);
const answer = Object.values(state.session.turns.find(turn => turn.id === jobs[1].turnId).answers).join("\n");
assert.ok(answer.includes(word), "第二轮未正确引用第一轮上下文");
const found = await api.request(`/sessions?q=${session.id}`);
assert.ok(found.sessions.some(item => item.id === session.id), "会话搜索未找到新会话");
console.log(`通过：同一会话中两个不同 turn，先进先出，第二轮记住第一轮上下文。\n第二轮回复：${answer}\n可在 CLI 中用 /resume ${session.id} 查看。`);
