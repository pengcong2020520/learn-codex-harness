// 需要先 npm run server。本脚本明确调用真实模型，会产生对应 API 用量。
import assert from "node:assert/strict";
import { AgentClient, loadClientConnection } from "../client/modules/connection/index.mjs";

const api = new AgentClient(loadClientConnection());
const session = await api.request("/sessions", {});
console.log(`验证会话：${session.id}`);
const word = "木星钟摆";
const signal = AbortSignal.timeout(180000);
async function ask(text) {
  const { turnId } = await api.request("/turns", { threadId: session.id, text });
  const turn = await api.follow(session.id, turnId, () => {}, { signal });
  assert.equal(turn?.status, "completed", "真实模型调用未完成，请查看服务端协议日志。");
  return turn;
}
const first = await ask(`这是脚手架验证。请记住测试词：${word}。只回复：已记住。`);
const second = await ask("上一条消息让我记住的测试词是什么？只回复测试词。");
assert.notEqual(first.id, second.id);
const answer = Object.values(second.answers).join("\n");
assert.ok(answer.includes(word), "第二轮未正确引用第一轮上下文");
console.log(`通过：同一会话中两个不同 turn，第二轮记住第一轮上下文。\n第二轮回复：${answer}\n可在 CLI 中用 /resume ${session.id} 查看。`);
