// 复现：活动轮次 A 正在执行；对 A 的追加消息 B 在 prepareInput 阶段被拒绝（例如提到未授权 Skill），
// 检查 A 的工具权限上下文是否被一并撤销。
import { EventEmitter } from "node:events";
const root = process.argv[2];
const { PermissionGate } = await import(`${root}/server/modules/permissions/index.mjs`);
const { MessageService } = await import(`${root}/server/modules/messages/index.mjs`);
const { AppError } = await import(`${root}/shared/errors.mjs`);
const agent = { definition: { agent: { id: "a", knowledge: [] }, bindings: {} }, assertCurrent() {}, allowsTool: () => true, sources: [], outputs: { directory: "outputs" } };
const gate = new PermissionGate({ scope: { ownerId: "owner" }, agent });
const rpc = new EventEmitter(); rpc.request = async () => { throw new Error("不应调用"); };
const sessions = new EventEmitter();
sessions.prepareInput = async () => { throw new AppError("Skill 未授权或不可用：foo", 409, "SKILL_UNAVAILABLE"); };
const store = { patch: async () => true, pause: async () => {}, list: async () => [], paused: async () => true, recover: async () => {} };
const hub = { publish() {} };
const messages = new MessageService({ rpc, sessions, hub, config: {}, store, gate });
// A 已启动并进入执行中
gate.start({ id: "job-A", threadId: "th" });
gate.started("th", "turn-A");
console.log("追加前，turn-A 工具上下文:", gate.forTurn("th", "turn-A").taskId);
// 用户对 A 追加 B，B 在准备输入阶段被拒绝
await messages.steer({ id: "job-B", threadId: "th", text: "$foo 再补充一点", targetTurnId: "turn-A" });
try { gate.forTurn("th", "turn-A"); console.log("追加失败后，turn-A 工具上下文仍有效"); }
catch (error) { console.log("追加失败后，turn-A 的后续工具调用被拒绝:", error.message); }
