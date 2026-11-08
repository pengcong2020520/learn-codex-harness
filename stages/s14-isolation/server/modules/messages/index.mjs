import { currentIdentity, runOwner } from "../accounts/context.mjs";
import { userWorkspace } from "../accounts/workspace.mjs";
import { validateEffort } from "../gateway/router.mjs";
import { randomUUID } from "node:crypto";
import { AppError, requireId, requireText } from "../../../shared/errors.mjs";
import { executing, terminal } from "../data/jobs.mjs";
import { runChecks, stepOf } from "../workflows/index.mjs";

const CHAT = Object.freeze({ id: "chat", label: "普通对话", skill: null, params: null, grants: Object.freeze([]), checks: Object.freeze([]), steps: null });

// Product input scheduling only. Codex continues to own its Agent loop and context.
export class MessageService {
  constructor({ rpc, sessions, hub, config, store, queue, gate, usage = sessions.usage }) {
    Object.assign(this, { rpc, sessions, hub, config, store, queue, gate, usage });
    if (!store) throw new Error("必须注入任务仓储。");
    this.backend = queue ? "postgres-outbox+redis" : "test";
    this.locks = new Map();
    this.scheduled = new Set();
    this.timers = new Map();
    this.budgetTimers = new Map();
    this.closed = false;
    this.failure = null;
    this.onCompleted = ({ threadId, turn }) => {
      void this.serial(threadId, () => this.completed(threadId, turn)).catch(
        (error) => this.fail(error),
      );
    };
    this.onFatal = (error) => {
      void this.fail(error);
    };
    sessions.on("turnCompleted", this.onCompleted);
    sessions.on("usageError", this.onFatal);
    rpc.on("fatal", this.onFatal);
  }
  async open() {
    await this.store.recover("服务曾重启，执行结果待核对，不会自动重发。");
    this.queue?.start(
      (id) => this.schedule(id),
      (error) => this.fail(error),
    );
    return this;
  }
  serial(id, operation) {
    const next = (this.locks.get(id) || Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.locks.set(id, next);
    next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => {});
    return next;
  }
  job(id) {
    return this.store.get(id);
  }
  async submit(body) {
    if (this.rpc.pool && !this.rpc.current()) return this.rpc.withOwner(currentIdentity().userId, () => this.submit(body));
    if (this.closed || this.stopping || this.failure)
      throw new AppError("执行服务不可用；请核对状态，不要盲目重发。", 503);
    if (Object.keys(body).some(key => !["threadId","clientMessageId","text","mode","targetTurnId","workflow","params","knowledge","model"].includes(key))) throw new AppError("消息只接受任务字段，身份由服务端认证确定。", 400);
    const principal = this.gate?.submission();
    const threadId = requireId(body.threadId, "会话 ID"),
      id = requireId(body.clientMessageId, "消息 ID"),
      text = requireText(body.text);
    const model = body.model ?? null;
    if (body.model !== undefined) {
      if (typeof model !== "string" || !model.trim() || model.length > 200) throw new AppError("model 必须是场景名或服务商/模型名。", 400);
      if (!this.config.launch.router) throw new AppError("按任务选模型需要启用模型网关。", 400);
      try { this.config.launch.router.resolve({ model }); }
      catch (error) { throw new AppError(error.message, 400, error.code); }
    }
    const workflow = this.resolve(this.legacyWorkflow(body));
    if (workflow.grants.length && this.gate) await this.gate.run(principal, () => this.gate.authorize(workflow.grants));
    const mode = body.mode || "enqueue";
    if (workflow.id !== "chat" && mode === "append") throw new AppError("Workflow 任务必须作为新任务提交；追加消息沿用当前任务的授权，不能更换 Workflow。", 403);
    if (!["enqueue", "append"].includes(mode))
      throw new AppError("消息模式只能是 enqueue 或 append。");
    const targetTurnId =
      mode === "append"
        ? requireId(body.targetTurnId, "追加目标 turn ID")
        : null;
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      if (this.closed || this.stopping || this.failure)
        throw new AppError("执行服务不可用。", 503);
      const existing = await this.job(id);
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.text !== text ||
          existing.mode !== mode ||
          (existing.model || null) !== model ||
          existing.targetTurnId !== targetTurnId ||
          (existing.workflow || "chat") !== workflow.id ||
          JSON.stringify(existing.params || null) !== JSON.stringify(workflow.params)
        )
          throw new AppError(
            "同一个消息 ID 不能用于不同的消息。",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        return this.publicJob(existing);
      }
      if (mode === "append" && !this.sessions.getTurn(threadId, targetTurnId))
        throw new AppError("追加目标不属于该会话或尚不可定位。", 409);
      try {
        await this.store.create({
          id,
          threadId,
          userId: principal?.userId || currentIdentity()?.userId,
          text,
          mode,
          targetTurnId,
          workflow: workflow.id,
          params: workflow.params,
          model,
          step: 0,
          agentHash: this.config.agent?.descriptor?.hash,
          createdAt: Date.now(),
        });
      } catch (error) {
        if (error.code === "23505") {
          if (!await this.job(id)) throw new AppError("资源不存在。", 404);
          throw new AppError("消息 ID 冲突，请核对原消息。", 409);
        }
        throw error;
      }
      await this.publish(threadId);
      if (!this.queue) this.schedule(threadId); // Test-only; production consumes Redis.
      return this.publicJob(await this.job(id));
    });
  }
  // 旧字段 knowledge: { kbId, operation: "update" } 等价于 knowledge-maintain，兼容一个版本。
  legacyWorkflow(body) {
    if (body.knowledge === undefined) return { id: body.workflow ?? "chat", params: body.params ?? null };
    const value = body.knowledge;
    if (body.workflow !== undefined || body.params !== undefined) throw new AppError("knowledge 与 workflow 不能同时使用。", 400);
    if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "kbId,operation" || value.operation !== "update")
      throw new AppError("knowledge 字段只接受 { kbId, operation: \"update\" }。", 400);
    return { id: "knowledge-maintain", params: { kbId: value.kbId } };
  }
  resolve({ id, params }) {
    if (typeof id !== "string") throw new AppError("workflow 必须是字符串。", 400);
    const workflows = this.config.agent?.workflows;
    if (!workflows) {
      if (id !== "chat") throw new AppError(`当前 Agent 没有启用这个 Workflow：${id}`, 403, "WORKFLOW_UNAVAILABLE");
      return CHAT;
    }
    return workflows.resolve(id, params);
  }
  // 一步结束后的去向：验收不通过 → needs-review（不暂停队列、不自动重试）；还有下一步 → 需要确认就 waiting，
  // 否则直接排队进入下一步；最后一步 → completed。
  outcome(job, turn) {
    if (turn?.status !== "completed" || job.mode === "append") return { status: turn?.status, checks: null };
    let workflow;
    try { workflow = this.resolve({ id: job.workflow || "chat", params: job.params ?? null }); } catch { return { status: "completed", checks: null }; }
    const step = stepOf(workflow, job.step || 0);
    const checks = step.checks.length ? runChecks(step.checks, turn, { workspaceDir: job.userId && this.config.agent?.runtime?.workspaceDir ? userWorkspace(this.config.agent.descriptorWorkspace || this.config.agent.runtime.workspaceDir, job.userId) : this.config.agent?.runtime?.workspaceDir, formats: this.config.agent?.outputs?.formats }) : null;
    if (checks && !checks.every(check => check.passed)) return { status: "needs-review", checks };
    if (step.index < step.total - 1) return step.confirm ? { status: "waiting", checks } : { status: "queued", step: step.index + 1, checks };
    return { status: "completed", checks };
  }
  // 模型在任务中提议另一个 workflow：只校验并记录为 proposed，不排队、不授权。由工具调用，context 来自权限门。
  async propose(context, { workflow: id, params = null, text, reason, ...rest }) {
    if (Object.keys(rest).length) throw new AppError("提议只接受 workflow、params、text 与 reason。", 400);
    const threadId = requireId(context.threadId, "会话 ID");
    const workflow = this.resolve({ id, params });
    if (workflow.id === "chat") throw new AppError("普通对话不需要提议，直接回答即可。", 400);
    const body = requireText(text), why = requireText(reason).slice(0, 500);
    return this.serial(threadId, async () => {
      if ((await this.store.list(threadId)).filter(job => job.status === "proposed").length >= 3)
        throw new AppError("本会话已有 3 个待确认的提议，请先等用户处理。", 429);
      const job = { id: randomUUID(), threadId, userId: context.userId, text: body, mode: "enqueue", targetTurnId: null,
        workflow: workflow.id, params: workflow.params, step: 0, status: "proposed", reason: why,
        agentHash: this.config.agent?.descriptor?.hash, createdAt: Date.now() };
      await this.store.create(job);
      await this.publish(threadId);
      return { taskId: job.id, status: "proposed", workflow: workflow.id, note: "已提议，等待用户确认；确认前不会执行，也不授予任何权限。" };
    });
  }
  // 用户确认：等待中的多步任务进入下一步；模型提议的任务在用户身份下核对授权后排队。text 是可选的补充说明。
  async confirm({ threadId, taskId, text, ...rest }) {
    if (Object.keys(rest).length) throw new AppError("确认只接受 threadId、taskId 与 text。", 400);
    requireId(threadId, "会话 ID"); requireId(taskId, "任务 ID");
    const note = text == null || text === "" ? null : requireText(text);
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      const job = await this.job(taskId);
      if (!job || job.threadId !== threadId) throw new AppError("任务不属于该会话。", 404);
      if (job.status === "proposed") {
        const workflow = this.resolve({ id: job.workflow, params: job.params ?? null });
        if (workflow.grants.length) this.gate?.authorize(workflow.grants);
      }
      const fields = job.status === "proposed" ? { status: "queued", note } : { status: "queued", step: (job.step || 0) + 1, note };
      if (!(await this.store.patch(taskId, fields, ["waiting", "proposed"])))
        throw new AppError("只有等待确认的任务可以继续。", 409);
      await this.publish(threadId);
      await this.wake(threadId);
      return this.publicJob(await this.job(taskId));
    });
  }
  // 结束等待确认或尚未开始的任务；正在执行的轮次不受影响。
  async cancel({ threadId, taskId, ...rest }) {
    if (Object.keys(rest).length) throw new AppError("结束任务只接受 threadId 与 taskId。", 400);
    requireId(threadId, "会话 ID"); requireId(taskId, "任务 ID");
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      const job = await this.job(taskId);
      if (!job || job.threadId !== threadId) throw new AppError("任务不属于该会话。", 404);
      if (!(await this.store.patch(taskId, { status: "cancelled" }, ["queued", "waiting", "proposed"])))
        throw new AppError("只有排队中、等待确认或提议中的任务可以结束。", 409);
      await this.publish(threadId);
      return this.publicJob(await this.job(taskId));
    });
  }
  schedule(threadId) {
    if (this.closed || this.stopping || this.failure || this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drain = (this.drain || Promise.resolve()).then(async () => {
        // PostgreSQL sequence order survives restarts and unordered Redis wakeups.
        const jobs = await (this.store.allPending?.() || this.store.list(null, { history: false }));
        const threads = new Map(jobs.filter(job => job.status === "queued").map(job => [job.threadId, job.userId]));
        for (const [id, ownerId] of threads) {
          const dispatch = () => this.serial(id, () => this.rpc.withOwner ? this.rpc.withOwner(ownerId, () => this.dispatch(id)) : this.dispatch(id));
          try { await (ownerId ? runOwner(ownerId, dispatch) : dispatch()); }
          catch (error) {
            if (this.rpc.pool) {
              // 运行环境容量不足/单个用户启动失败不能停止其他 owner 的派发。
              if (error.code !== 'RUNTIME_BUSY') await runOwner(ownerId, () => this.failOwner(ownerId, error));
            } else throw error;
          }
        }
      }).catch(error => this.fail(error));
    });
  }
  async dispatch(threadId) {
    if (this.closed || this.stopping || this.failure || (await this.store.paused(threadId)))
      return;
    if (!this.sessions.sessions.has(threadId)) {
      try {
        await this.sessions.ensure(threadId);
      } catch {
        await this.store.pause(threadId);
        await this.publish(threadId);
        return;
      }
    }
    const all = await this.store.list(threadId, { history: false }),
      pending = all.filter((j) => j.status === "queued");
    const active = this.sessions.snapshot(threadId).activeTurnId;
    const append = pending.find(
      (j) => j.mode === "append" && j.targetTurnId === active,
    );
    if (append) {
      await this.steer(append);
      return;
    }
    if (active || all.some((j) => executing.includes(j.status))) return;
    const job = pending.find((j) => j.mode === "append") || pending[0];
    if (!job) return;
    const running = new Set((await (this.store.allPending?.() || this.store.list(null, { history: false })))
      .filter(item => executing.includes(item.status)).map(item => item.threadId));
    for (const [id, session] of this.sessions.sessions) if (session.activeTurnId) running.add(id);
    const maxConcurrentTurns = this.config.deployment?.maxConcurrentTurns ?? 2;
    if (running.size >= maxConcurrentTurns) return;
    const budget = await this.usage?.budgetStatus();
    if (budget?.exceeded) {
      this.retryBudget(threadId, budget);
      await this.publish(threadId);
      return;
    }
    clearTimeout(this.budgetTimers.get(threadId));
    this.budgetTimers.delete(threadId);
    if (!(await this.store.patch(job.id, { status: "starting", selectedModel: null, modelSource: null }, ["queued"])))
      return;
    await this.publish(threadId);
    let sent = false;
    try {
      const workflow = this.resolve({ id: job.workflow || "chat", params: job.params ?? null });
      const step = stepOf(workflow, job.step || 0);
      // 第二步起不重发原文：会话历史里已有原始要求，这里只说明用户已确认，并带上补充说明。
      const extra = job.note ? `\n用户补充：${job.note}` : "";
      let input = step.index ? `用户已确认上一步，请继续。${extra}` : `${job.text}${extra}`;
      if (job.mode === "append") {
        const original = this.sessions
          .getTurn(threadId, job.targetTurnId)
          ?.messages.map((m) => m.text)
          .join("\n")
          .slice(0, 6000);
        input = `这是对本会话先前任务（turn ID: ${job.targetTurnId}）的补充。${original ? `\n目标任务的用户要求（引用）：\n${original}\n` : "\n"}本次补充要求：\n${job.text}`;
      }
      await this.sessions.atBoundary(async () => {
        if (this.closed || this.stopping || this.failure) {
          const error = new Error("服务已关闭或连接失效。");
          // 关闭时请求还没发出，不能写成明确失败，否则会盖掉待核对。
          if (this.stopping || this.closed) error.uncertain = true;
          throw error;
        }
        const prepared = await this.sessions.prepareInput(
          threadId,
          input,
          job.agentHash,
          workflow.id === "chat" ? null : workflow,
          step.index,
        );
        // 优先级：步骤 > 任务 > 默认；预算只替换场景或默认选择，能力要求继续生效。
        const router = this.config.launch.router;
        let selection = step.model || job.model || null;
        let modelSource = step.model ? "步骤指定" : job.model ? "任务指定" : "默认路由";
        if (router && budget?.downgraded && !selection?.includes("/")) {
          selection = budget.downgradeScene;
          modelSource = "预算降级";
        }
        if (selection) modelSource += `：${selection.includes("/") ? "" : "场景 "}${selection}`;
        const chosen = router?.resolve({ model: selection, needs: step.needs });
        if (chosen) validateEffort(chosen, step.effort);
        const model = chosen?.id || this.config.launch.model || this.sessions.snapshot(threadId).model || "unknown";
        await this.store.patch(job.id, { selectedModel: model, modelSource });
        await this.publish(threadId);
        this.gate?.start(job, workflow.grants, step.writes);
        sent = true;
        this.sessions.prepareUsage(threadId, { model, taskId: job.id });
        const result = await this.rpc.request("turn/start", {
          threadId,
          clientUserMessageId: job.id,
          input: prepared,
          ...(router ? { model, effort: step.effort || chosen.spec.defaultReasoningLevel || null } : {}),
        });
        const turn = this.sessions.recordTurn(threadId, result.turn);
        await this.bind(job.id, result.turn.id);
        this.sessions.publish(threadId, turn);
      });
    } catch (error) {
      // 只结束本任务自己开启的权限上下文：gate.start 成功后 sent 才为真；start 被拒（该会话已有运行中的任务）时不能结束别人的。
      if (sent) this.gate?.end(threadId);
      await this.executionError(job, error, sent);
    } finally {
      this.sessions.finishUsageStart(threadId);
    }
    await this.publish(threadId);
  }
  retryBudget(threadId, budget) {
    if (this.budgetTimers.has(threadId) || this.closed || this.stopping || this.failure) return;
    const wait = Math.max(1, Math.min(180000, Date.parse(budget.resetsAt) - this.usage.now()));
    const timer = setTimeout(() => {
      this.budgetTimers.delete(threadId);
      if (!this.closed && !this.failure) this.schedule(threadId);
    }, wait);
    timer.unref();
    this.budgetTimers.set(threadId, timer);
  }
  async steer(job) {
    if (!(await this.store.patch(job.id, { status: "steering" }, ["queued"])))
      return;
    let sent = false;
    try {
      const input = await this.sessions.prepareInput(
        job.threadId,
        job.text,
        job.agentHash,
      );
      const original = (await this.store.list(job.threadId)).find(item => item.turnId === job.targetTurnId && item.selectedModel);
      await this.store.patch(job.id, { selectedModel: original?.selectedModel || this.sessions.snapshot(job.threadId).model,
        modelSource: "沿用当前轮次" });
      sent = true;
      const result = await this.rpc.request("turn/steer", {
        threadId: job.threadId,
        expectedTurnId: job.targetTurnId,
        clientUserMessageId: job.id,
        input,
      });
      await this.bind(job.id, result.turnId);
    } catch (error) {
      if (
        error.code === -32600 &&
        (error.message === "no active turn to steer" ||
          /^expected active turn id `/.test(error.message))
      ) {
        try {
          await this.store.patch(job.id, { status: "queued" });
          await this.wake(job.threadId);
        } catch (capacityError) {
          if (capacityError.code !== 'QUEUE_FULL') throw capacityError;
          await this.store.patch(job.id, { status: 'failed', error: '全局排队已满，追加未发送。' });
        }
      } else await this.executionError(job, error, sent);
    }
    await this.publish(job.threadId);
  }
  // steer 失败也走这里：追加消息沿用正在运行轮次的权限上下文，这里不结束它，否则该轮后续的工具调用都会被拒。
  async executionError(job, error, sent) {
    const knownRejection = Number.isInteger(error.code);
    await this.store.patch(job.id, {
      status:
        error.uncertain || (sent && !knownRejection) ? "unconfirmed" : "failed",
      error: error.message,
    });
    await this.store.pause(job.threadId);
  }
  async patchOutcome(job, fields, expected) {
    try { return await this.store.patch(job.id, fields, expected); }
    catch (error) {
      if (error.code !== 'QUEUE_FULL' || fields.status !== 'queued') throw error;
      // Completion must not kill the executor when the next workflow step cannot queue.
      return this.store.patch(job.id, { ...fields, status: 'waiting', step: job.step || 0,
        error: '全局排队已满；容量释放后请确认下一步。' }, expected);
    }
  }
  async bind(id, turnId) {
    if (this.closed || this.stopping || this.failure) return;
    const job = await this.job(id),
      turn = this.sessions.getTurn(job.threadId, turnId);
    const ended = terminal.includes(turn?.status);
    if (ended) await this.sessions.persistTurn?.(job.threadId, turn);
    const { status, checks, step: next } = ended ? this.outcome(job, turn) : { status: "running", checks: null };
    if (
      !(await this.patchOutcome(
        job,
        { turnId, status, error: turn?.error || null, ...(checks ? { checks } : {}), ...(next !== undefined ? { step: next } : {}) },
        executing,
      ))
    )
      return;
    if (ended) {
      if (turn.status !== "completed") await this.store.pause(job.threadId);
      await this.wake(job.threadId);
    } else if (!this.timers.has(turnId)) {
      const timer = setTimeout(() => {
        void this.serial(job.threadId, async () => {
          this.timers.delete(turnId);
          if (
            this.closed ||
            this.sessions.getTurn(job.threadId, turnId)?.status !== "inProgress"
          )
            return;
          await this.store.pause(job.threadId);
          const interrupt = () => this.rpc.request("turn/interrupt", { threadId: job.threadId, turnId });
          await (job.userId ? runOwner(job.userId, interrupt) : interrupt());
        }).catch(error => this.rpc.pool ? this.failOwner(job.userId, error) : this.fail(error));
      }, this.config.turnTimeoutMs ?? this.config.launch.timeoutMs);
      timer.unref();
      this.timers.set(turnId, timer);
    }
  }
  async completed(threadId, turn) {
    clearTimeout(this.timers.get(turn.id));
    this.timers.delete(turn.id);
    await this.sessions.persistTurn?.(threadId, turn);
    for (const job of await this.store.list(threadId))
      if (job.turnId === turn.id && executing.includes(job.status)) {
        const { status, checks, step } = this.outcome(job, turn);
        await this.patchOutcome(
          job,
          { status, error: turn.error || null, ...(checks ? { checks } : {}), ...(step !== undefined ? { step } : {}) },
          executing,
        );
      }
    if (turn.status !== "completed") await this.store.pause(threadId);
    await this.publish(threadId);
    await this.wake(threadId);
  }
  async wake(threadId) {
    await this.store.wake(threadId);
    if (!this.queue) this.schedule(threadId);
  }
  async continue(threadId) {
    requireId(threadId, "会话 ID");
    if (this.closed || this.stopping || this.failure)
      throw new AppError("请先重启执行服务，再核对状态。", 503);
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      await this.store.pause(threadId, false);
      await this.publish(threadId);
      await this.wake(threadId);
      return this.snapshot(threadId);
    });
  }
  async failOwner(owner, error) {
    return runOwner(owner, async () => {
      for (const [id, session] of this.sessions.sessions) if (session.ownerId === owner) {
        this.gate?.end(id);
        for (const turn of session.turns.values()) { clearTimeout(this.timers.get(turn.id)); this.timers.delete(turn.id); }
        session.activeTurnId = null;
      }
      await this.store.recoverOwner(error.message);
      this.hub.publish('fatal', { message: '该用户运行环境已停止，执行结果待核对。' }, null, owner);
    });
  }
  async fail(error) {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.gate?.close();
    const closing = this.rpc.close?.();
    try {
      await this.store.recover(error.message);
    } catch {
      /* Startup fences durable starting/running states. */
    }
    await closing?.catch(() => {});
    for (const ownerId of new Set([...this.sessions.sessions.values()].map(session => session.ownerId).filter(Boolean))) {
      this.hub.publish("fatal", { message: "执行服务已停止调度，请检查服务端并核对任务结果。" }, null, ownerId);
    }
  }
  publicJob(job) {
    let steps = null;
    try { steps = this.resolve({ id: job.workflow || "chat", params: job.params ?? null }).steps; } catch { /* workflow 已不可用时只返回原始记录。 */ }
    return { ...job, text: job.text.slice(0, 1000), ...(steps ? { stepId: steps[job.step || 0]?.id, steps: steps.length } : {}) };
  }
  async snapshot(threadId) {
    const all = await this.store.list(threadId),
      unfinished = all.filter((j) => !terminal.includes(j.status)),
      queued = unfinished.filter((j) => j.status === "queued");
    const ordered = [
      ...unfinished.filter((j) => j.status !== "queued"),
      ...queued.filter((j) => j.mode === "append"),
      ...queued.filter((j) => j.mode !== "append"),
      ...all.filter((j) => terminal.includes(j.status)).slice(-20),
    ];
    return {
      threadId,
      paused: await this.store.paused(threadId),
      budget: await this.usage?.budgetStatus() || { exceeded: false, reason: null, resetsAt: null },
      jobs: ordered.map((j) => this.publicJob(j)),
    };
  }
  async publish(threadId) {
    this.hub.publish("queue", await this.snapshot(threadId), threadId, currentIdentity()?.userId || this.sessions.sessions.get(threadId)?.ownerId);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.budgetTimers.values()) clearTimeout(timer);
    this.budgetTimers.clear();
    this.sessions.off("turnCompleted", this.onCompleted);
    this.sessions.off("usageError", this.onFatal);
    this.rpc.off("fatal", this.onFatal);
    await Promise.allSettled([...this.locks.values()]);
    await this.drain;
    await this.store.recover(
      "服务关闭时尚未确认结果，请查看历史，不会自动重发。",
    );
  }
}
