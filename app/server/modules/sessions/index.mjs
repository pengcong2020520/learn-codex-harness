import { EventEmitter } from "node:events";
import { listProjectThreads, importLegacyThread, ensureThreadDirectory } from "./history.mjs";
import { AppError, requireId } from "../../../shared/errors.mjs";
import { SESSION_TURN_LIMIT } from "../../../shared/session-events.mjs";

const copyTurn = turn => ({ ...turn, answers: { ...turn.answers }, artifacts: { ...turn.artifacts }, revisions: { ...turn.revisions },
  tools: Object.fromEntries(Object.entries(turn.tools).map(([id, tool]) => [id, { ...tool }])), messages: [...turn.messages] });

export class SessionService extends EventEmitter {
  constructor({ rpc, config, runtime, hub, redact, tools, boundary, beforeTurn, repository, publishInterval = 100 }) {
    super();
    Object.assign(this, { rpc, config, runtime, hub, redact, tools, boundary, beforeTurn, repository, publishInterval });
    this.sessions = new Map();
    this.timers = new Map();
    // 每个会话尚未推送的回复增量：同一条回复在一个推送周期内合并成一段。
    this.deltas = new Map();
    // 每条回复各自的流式脱敏窗口；不挂在 turn 上，避免未脱敏的尾部进入快照。
    this.streams = new WeakMap();
    this.loading = new Map();
    this.options = {
      sandbox: config.agent?.execution.sandbox || "read-only",
      approvalPolicy: config.agent?.execution.approvalPolicy || "never",
      baseInstructions: config.agent?.instructions || "",
      ...(config.launch.model ? { model: config.launch.model } : {}),
      ...(config.launch.authMode === "apiKey" ? { modelProvider: "project_api" } : {})
    };
    this.onNotification = message => this.handleNotification(message);
    rpc.on("notification", this.onNotification);
  }

  async create() {
    return this.atBoundary(async () => {
      this.config.agent?.assertCurrent();
      const result = await this.rpc.request("thread/start", { ...this.options, cwd: this.runtime.workspaceDir, ...(this.tools?.gate ? { dynamicTools: this.tools.dynamicTools() } : {}) });
      if (this.config.agent) {
        await this.rpc.request("thread/memoryMode/set", { threadId: result.thread.id, mode: this.config.memory.contribute ? "enabled" : "disabled" });
        await this.config.agent.bind(result.thread.id);
      }
      return this.register(result);
    }, { allowBusy: true });
  }

  atBoundary(operation, options) { return this.boundary ? this.boundary.run(operation, options) : operation(); }

  assertCompatible(threadId, jobHash) { return this.config.agent?.assertCompatible(threadId, jobHash); }
  async prepareInput(threadId, text, jobHash, workflow = null) {
    await this.assertCompatible(threadId, jobHash);
    await this.beforeTurn?.();
    return this.config.agent?.input(text, workflow) || [{ type: "text", text, text_elements: [] }];
  }

  register(result) {
    const thread = result.thread;
    const session = { id: thread.id, cwd: thread.cwd || this.runtime.workspaceDir,
      name: thread.name || thread.preview || "新会话", model: result.model,
      modelProvider: result.modelProvider, activeTurnId: null, lastTurnId: null, turns: new Map() };
    this.sessions.set(session.id, session);
    for (const turn of thread.turns || []) this.recordTurn(session.id, turn);
    this.publish(session.id);
    return this.snapshot(session.id);
  }

  async list(keyword = "") {
    if (this.repository) return this.repository.listConversations(keyword);
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
    if (this.sessions.has(threadId)) { await this.assertCompatible(threadId); return this.snapshot(threadId); }
    if (!this.loading.has(threadId)) {
      const promise = this.load(threadId).finally(() => this.loading.delete(threadId));
      this.loading.set(threadId, promise);
    }
    return this.loading.get(threadId);
  }

  async load(threadId) {
    const selected = this.repository ? await this.repository.conversation(threadId) :
      (await listProjectThreads(this.rpc.request.bind(this.rpc), this.config.root, "", this.runtime.workspaceDir)).find(thread => thread.id === threadId);
    if (!selected) throw new AppError("未找到本项目的这个会话。", 404, "THREAD_NOT_FOUND");
    return this.atBoundary(async () => {
      await this.assertCompatible(threadId);
      const legacyPath = this.tools && !this.repository ? await importLegacyThread(this.config.root, selected) : undefined;
      await ensureThreadDirectory(this.config.root, selected.cwd, this.runtime.workspaceDir);
      const result = await this.rpc.request("thread/resume", {
        ...this.options, threadId, cwd: selected.cwd, excludeTurns: false,
        ...(legacyPath ? { path: legacyPath } : {})
      });
      if (result.thread.id !== threadId) throw new AppError("历史文件与 Thread id 不一致。", 409);
      return this.register(result);
    }, { allowBusy: true });
  }

  getTurn(threadId, turnId) { return this.sessions.get(threadId)?.turns.get(turnId); }
  persistTurn(threadId, turn) { return this.repository?.recordArtifacts(threadId, turn); }

  recordTurn(threadId, turn) {
    const session = this.sessions.get(threadId);
    if (!session || !turn?.id) return;
    let record = session.turns.get(turn.id);
    if (!record) {
      record = { id: turn.id, status: turn.status || "inProgress", answers: {}, tools: {}, artifacts: {}, revisions: {}, messages: [], error: null };
      session.turns.set(turn.id, record);
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

  applyItem(turn, item) {
    if (["dynamicToolCall", "mcpToolCall"].includes(item.type)) {
      const failed = item.status === "failed" || item.success === false || item.result?.isError === true || Boolean(item.error);
      let error = null;
      if (failed) {
        error = item.error?.message;
        try { error ||= JSON.parse(item.contentItems?.find(part => part.type === "inputText")?.text || item.result?.content?.find(part => part.type === "text")?.text || "{}").error; } catch { /* 不向界面打印原始工具输出。 */ }
      }
      turn.tools[item.id] = { name: item.tool, label: this.tools?.label(item.tool) || item.tool, status: failed ? "failed" : item.status,
        error: error ? this.redact(String(error)).slice(0, 300) : null };
      // 只记录工具真实返回的结果，供 workflow 验收使用；不从模型回复中猜测文件或修订。
      if (!failed && item.status === "completed" && ["write_file", "kb_submit_revision"].includes(item.tool)) {
        try {
          const output = JSON.parse(item.result?.content?.find(part => part.type === "text")?.text || item.contentItems?.find(part => part.type === "inputText")?.text || "null");
          const sources = Array.isArray(item.arguments?.source_versions) ? item.arguments.source_versions.length : 0;
          if (item.tool === "write_file" && output?.created === true && output.artifact) turn.artifacts[item.id] = { ...output.artifact, sources };
          if (item.tool === "kb_submit_revision" && output?.effective === true)
            turn.revisions[item.id] = { kbId: output.kbId, slug: output.slug, versionId: output.versionId, effective: true };
        } catch { /* 工具错误不算产物或修订。 */ }
      }
    }
    if (item.type === "agentMessage" && typeof item.text === "string") {
      // 整段文本是权威结果，覆盖增量拼接的内容，并丢弃这条回复的流式窗口。
      turn.answers[item.id] = this.redact(item.text);
      this.streams.get(turn)?.delete(item.id);
    }
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
    if (!turnId) return;
    let turn = this.getTurn(threadId, turnId);
    const known = Boolean(turn);
    let rewritten = false;
    if (message.method === "turn/started" || message.method === "turn/completed") {
      turn = this.recordTurn(threadId, params.turn);
    } else {
      turn ||= this.recordTurn(threadId, { id: turnId, status: "inProgress" });
      if (message.method === "item/agentMessage/delta") rewritten = this.appendDelta(threadId, turn, params.itemId, params.delta);
      if (["item/started", "item/completed"].includes(message.method) && params.item) this.applyItem(turn, params.item);
    }
    if (message.method === "turn/completed") this.flushStreams(turn);
    // 增量只追加一条回复的文字，合并到下一个推送周期；其他状态变化立即推送这一轮。
    if (message.method === "item/agentMessage/delta" && known && !rewritten) this.schedule(threadId);
    else this.publish(threadId, turn);
    if (message.method === "turn/completed") this.emit("turnCompleted", { threadId, turn });
  }

  // 每段增量只脱敏新到的文字，不再对整条回复反复脱敏。放行的文字记为待推送增量；
  // 返回 true 表示回复被整段改写，不能用增量表达，需要推送整轮。
  appendDelta(threadId, turn, itemId, delta) {
    const before = turn.answers[itemId] || "";
    let released;
    if (this.redact.stream) {
      let streams = this.streams.get(turn);
      if (!streams) this.streams.set(turn, streams = new Map());
      if (!streams.has(itemId)) streams.set(itemId, this.redact.stream());
      released = streams.get(itemId).push(delta);
    } else {
      const text = this.redact(before + delta);
      if (!text.startsWith(before)) { turn.answers[itemId] = text; return true; }
      released = text.slice(before.length);
    }
    if (!released) return false;
    turn.answers[itemId] = before + released;
    let pending = this.deltas.get(threadId);
    if (!pending) this.deltas.set(threadId, pending = new Map());
    const key = `${turn.id}\n${itemId}`;
    if (pending.has(key)) pending.get(key).text += released;
    else pending.set(key, { turnId: turn.id, itemId, offset: before.length, text: released });
    return false;
  }

  // 轮次结束时，放行没有等到 item/completed 的回复仍被扣住的尾部。
  flushStreams(turn) {
    for (const [itemId, stream] of this.streams.get(turn) || []) {
      const rest = stream.end();
      if (rest) turn.answers[itemId] = (turn.answers[itemId] || "") + rest;
    }
    this.streams.delete(turn);
  }

  schedule(threadId) {
    if (this.timers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      this.flushDeltas(threadId);
    }, this.publishInterval);
    timer.unref?.();
    this.timers.set(threadId, timer);
  }

  flushDeltas(threadId, exceptTurnId) {
    const pending = this.deltas.get(threadId);
    this.deltas.delete(threadId);
    for (const delta of pending?.values() || []) if (delta.turnId !== exceptTurnId) this.hub.publish("delta", delta, threadId);
  }

  // 给出 turn 时只推这一轮的完整状态，否则推整个会话。完整状态已含待推送的文字，对应增量不再单独推；
  // 其他轮次的增量先推出，保持发生顺序。
  publish(threadId, turn) {
    clearTimeout(this.timers.get(threadId));
    this.timers.delete(threadId);
    if (!turn) { this.deltas.delete(threadId); return this.hub.publish("session", this.snapshot(threadId), threadId); }
    this.flushDeltas(threadId, turn.id);
    const session = this.sessions.get(threadId);
    this.hub.publish("turn", { name: session.name, activeTurnId: session.activeTurnId, lastTurnId: session.lastTurnId, turn: copyTurn(turn) }, threadId);
  }

  snapshot(threadId) {
    const session = this.sessions.get(threadId);
    if (!session) throw new AppError("会话尚未载入。", 404);
    return { id: session.id, name: session.name, model: session.model, modelProvider: session.modelProvider,
      activeTurnId: session.activeTurnId, lastTurnId: session.lastTurnId,
      turns: [...session.turns.values()].slice(-SESSION_TURN_LIMIT).map(copyTurn) };
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deltas.clear();
    this.rpc.off("notification", this.onNotification);
  }
}
