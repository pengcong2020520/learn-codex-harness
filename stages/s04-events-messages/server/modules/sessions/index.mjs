import { EventEmitter } from "node:events";
import { listProjectThreads, importLegacyThread, ensureThreadDirectory } from "./history.mjs";
import { AppError, requireId } from "../../../shared/errors.mjs";
import { AGENT_INSTRUCTIONS } from "../role/index.mjs";

// 内存只保留近期轮次；完整历史仍由 Codex 原生记录保存。
export const SESSION_TURN_MEMORY = 100;

export class SessionService extends EventEmitter {
  constructor({ rpc, config, runtime, hub, redact }) {
    super();
    Object.assign(this, { rpc, config, runtime, hub, redact });
    this.sessions = new Map();
    this.loading = new Map();
    this.options = {
      sandbox: "read-only",
      approvalPolicy: "never",
      baseInstructions: AGENT_INSTRUCTIONS,
      ...(config.launch.model ? { model: config.launch.model } : {}),
      ...(config.launch.authMode === "apiKey" ? { modelProvider: "project_api" } : {})
    };
    this.onNotification = message => this.handleNotification(message);
    rpc.on("notification", this.onNotification);
  }

  async create() {
    const result = await this.rpc.request("thread/start", { ...this.options, cwd: this.runtime.workspaceDir });
    return this.register(result);
  }

  // 发给 Codex 的输入：只有用户这一句，不拼接历史。
  input(text) { return [{ type: "text", text, text_elements: [] }]; }

  register(result) {
    const thread = result.thread;
    const session = { id: thread.id, cwd: thread.cwd || this.runtime.workspaceDir,
      name: thread.name || thread.preview || "新会话", model: result.model,
      modelProvider: result.modelProvider, activeTurnId: null, lastTurnId: null, turns: new Map(), forgottenTurnIds: new Set() };
    this.sessions.set(session.id, session);
    for (const turn of thread.turns || []) this.recordTurn(session.id, turn);
    this.publish(session.id);
    return this.snapshot(session.id);
  }

  async list(keyword = "") {
    const stored = await listProjectThreads(this.rpc.request.bind(this.rpc), this.config.root, keyword, this.runtime.workspaceDir);
    const found = new Map(stored.map(thread => [thread.id, thread]));
    const query = keyword.toLocaleLowerCase();
    for (const session of this.sessions.values()) {
      if (!found.has(session.id) && `${session.id} ${session.name}`.toLocaleLowerCase().includes(query)) {
        found.set(session.id, { id: session.id, name: session.name, cwd: session.cwd });
      }
    }
    return [...found.values()].map(({ id, name, preview, updatedAt, cwd }) => ({ id, name, preview, updatedAt, cwd }));
  }

  async ensure(threadId) {
    requireId(threadId, "会话 ID");
    if (this.sessions.has(threadId)) return this.snapshot(threadId);
    if (!this.loading.has(threadId)) {
      const promise = this.load(threadId).finally(() => this.loading.delete(threadId));
      this.loading.set(threadId, promise);
    }
    return this.loading.get(threadId);
  }

  async load(threadId) {
    const selected = (await listProjectThreads(this.rpc.request.bind(this.rpc), this.config.root, "", this.runtime.workspaceDir)).find(thread => thread.id === threadId);
    if (!selected) throw new AppError("未找到本项目的这个会话。", 404, "THREAD_NOT_FOUND");
    const legacyPath = await importLegacyThread(this.config.root, selected);
    await ensureThreadDirectory(this.config.root, selected.cwd, this.runtime.workspaceDir);
    const result = await this.rpc.request("thread/resume", {
      ...this.options, threadId, cwd: selected.cwd, excludeTurns: false,
      ...(legacyPath ? { path: legacyPath } : {})
    });
    if (result.thread.id !== threadId) throw new AppError("历史文件与 Thread id 不一致。", 409);
    return this.register(result);
  }

  getTurn(threadId, turnId) { return this.sessions.get(threadId)?.turns.get(turnId); }

  recordTurn(threadId, turn) {
    const session = this.sessions.get(threadId);
    if (!session || !turn?.id || session.forgottenTurnIds.has(turn.id)) return;
    let record = session.turns.get(turn.id);
    if (!record) {
      record = { id: turn.id, status: turn.status || "inProgress", answers: {}, messages: [], error: null };
      session.turns.set(turn.id, record);
      this.forgetOldTurns(session);
    }
    // 早到的 completed 不能被随后到达的 turn/start RPC 响应覆盖成执行中。
    const terminal = ["completed", "failed", "interrupted"].includes(record.status);
    if (!(terminal && turn.status === "inProgress")) record.status = turn.status || record.status;
    if (turn.error) record.error = this.redact(turn.error.message || JSON.stringify(turn.error));
    for (const item of turn.items || []) this.applyItem(record, item);
    if (record.status === "inProgress") session.activeTurnId = record.id;
    else if (session.activeTurnId === record.id) session.activeTurnId = null;
    // 不让旧轮次迟到的完成事件覆盖最新轮次的定位。
    session.lastTurnId = [...session.turns.keys()].at(-1) || null;
    return record;
  }

  // 从最早的轮次开始丢；执行中或仍被 activeTurnId 引用的轮次不能丢。
  forgetOldTurns(session) {
    for (const [id, turn] of session.turns) {
      if (session.turns.size <= SESSION_TURN_MEMORY) break;
      if (turn.status !== "inProgress" && id !== session.activeTurnId) {
        session.turns.delete(id);
        // 仅保留 ID，防止迟到通知或 RPC 响应把旧轮次重新加入近期视图。
        session.forgottenTurnIds.add(id);
      }
    }
  }

  applyItem(turn, item) {
    if (item.type === "agentMessage" && typeof item.text === "string") turn.answers[item.id] = this.redact(item.text);
    if (item.type === "userMessage" && !turn.messages.some(message => message.id === item.id)) {
      turn.messages.push({ id: item.id, clientId: item.clientId,
        text: this.redact((item.content || []).filter(part => part.type === "text").map(part => part.text).join("\n")) });
    }
  }

  handleNotification(message) {
    const params = message.params || {};
    const threadId = params.threadId;
    if (!this.sessions.has(threadId)) return;
    const turnId = params.turnId || params.turn?.id;
    if (!turnId || this.sessions.get(threadId).forgottenTurnIds.has(turnId)) return;
    let turn = this.getTurn(threadId, turnId);
    if (message.method === "turn/started" || message.method === "turn/completed") {
      turn = this.recordTurn(threadId, params.turn);
    } else {
      turn ||= this.recordTurn(threadId, { id: turnId, status: "inProgress" });
      if (message.method === "item/agentMessage/delta") {
        turn.answers[params.itemId] = this.redact((turn.answers[params.itemId] || "") + params.delta);
      }
      if (["item/started", "item/completed"].includes(message.method) && params.item) this.applyItem(turn, params.item);
    }
    this.publish(threadId);
    if (message.method === "turn/completed") this.emit("turnCompleted", { threadId, turn });
  }

  publish(threadId) {
    this.hub.publish("session", this.snapshot(threadId), threadId);
  }

  snapshot(threadId) {
    const session = this.sessions.get(threadId);
    if (!session) throw new AppError("会话尚未载入。", 404);
    return { id: session.id, name: session.name, model: session.model, modelProvider: session.modelProvider,
      activeTurnId: session.activeTurnId, lastTurnId: session.lastTurnId,
      turns: [...session.turns.values()].slice(-30).map(turn => ({ ...turn, answers: { ...turn.answers }, messages: [...turn.messages] })) };
  }

  close() { this.rpc.off("notification", this.onNotification); }
}
