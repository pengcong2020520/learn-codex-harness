// 用真实 SessionService 模拟：已有 N 轮历史，新一轮回答以 delta 流式到达，统计 hub 发布的总字节数与耗时。
import { EventEmitter } from "node:events";
const root = process.argv[2];
const { SessionService } = await import(`${root}/server/modules/sessions/index.mjs`);
const { EventHub } = await import(`${root}/server/modules/events/index.mjs`);
const { createLogRedactor } = await import(`${root}/server/modules/config/index.mjs`);
const rpc = new EventEmitter();
const hub = new EventHub();
const redact = createLogRedactor("sk-test-secret-key-1234567890", ["postgresql://agent:pw@127.0.0.1/agent", "redis://127.0.0.1:6379/0"]);
const sessions = new SessionService({ rpc, config: { launch: {}, root }, runtime: { workspaceDir: "/tmp" }, hub, redact });
for (const [history, answerKB, deltas] of [[5, 2, 300], [30, 5, 1000]]) {
  const turns = Array.from({ length: history }, (_, i) => ({ id: `t${i}`, status: "completed",
    items: [{ type: "userMessage", id: `u${i}`, content: [{ type: "text", text: "问题".repeat(50) }] },
            { type: "agentMessage", id: `a${i}`, text: "回答内容。".repeat(answerKB * 1024 / 15) }] }));
  sessions.sessions.clear();
  sessions.register({ thread: { id: "th", turns } });
  let bytes = 0, events = 0;
  const listener = e => { bytes += Buffer.byteLength(redact(e)); events++; };
  hub.on("event", listener);
  const t0 = performance.now();
  rpc.emit("notification", { method: "turn/started", params: { threadId: "th", turn: { id: "live", status: "inProgress" } } });
  for (let i = 0; i < deltas; i++) rpc.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "th", turnId: "live", itemId: "m", delta: "新增文本片段" } });
  const ms = performance.now() - t0;
  hub.off("event", listener);
  console.log(`历史 ${history} 轮 × ${answerKB}KB 回答，新回答 ${deltas} 个 delta（约 ${(deltas * 18 / 1024).toFixed(1)} KB 正文）→ SSE 事件 ${events} 个，共 ${(bytes / 1024 / 1024).toFixed(1)} MiB，CPU ${ms.toFixed(0)} ms`);
}
