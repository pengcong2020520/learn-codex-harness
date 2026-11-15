import { readAttachments, attachInput } from "./attachments.mjs";
import { effectiveKnowledgeMounts } from '../knowledge/mounts.mjs';
import { currentIdentity, runOwner } from "../accounts/context.mjs";
import { userWorkspace } from "../accounts/workspace.mjs";
import { validateEffort } from "../gateway/router.mjs";
import { randomUUID } from "node:crypto";
import { AppError, requireId, requireText } from "../../../shared/errors.mjs";
import { cancellable, executing, terminal } from "../data/jobs.mjs";
import { checksPassed, runChecks, stepOf } from "../workflows/index.mjs";

const CHAT = Object.freeze({ id: "chat", label: "普通对话", skill: null, params: null, grants: Object.freeze([]), checks: Object.freeze([]), steps: null });

// Product input scheduling only. Codex continues to own its Agent loop and context.
export class MessageService {
  constructor({ rpc, sessions, hub, config, store, queue, gate, permissionHub, files, usage = sessions.usage }) {
    Object.assign(this, { rpc, sessions, hub, config, store, queue, gate, usage, permissionHub, files });
    if (!store) throw new Error("必须注入任务仓储。");
    this.backend = queue ? "postgres-outbox+redis" : "test";
    this.locks = new Map();
    this.scheduled = new Set();
    this.timers = new Map();
    this.budgetTimers = new Map();
    this.runtimeTimers = new Map();
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
    this.permissionHub?.checkAgent(this.config.agent);
    if (this.closed || this.stopping || this.failure)
      throw new AppError("执行服务不可用；请核对状态，不要盲目重发。", 503);
    if (Object.keys(body).some(key => !["threadId","clientMessageId","text","mode","targetTurnId","workflow","params","knowledge","model","attachments"].includes(key))) throw new AppError("消息只接受任务字段，身份由服务端认证确定。", 400);
    const principal = this.gate?.submission();
    const threadId = requireId(body.threadId, "会话 ID"),
      id = requireId(body.clientMessageId, "消息 ID"),
      text = requireText(body.text);
    const attachments = body.attachments ?? [];
    if (body.attachments === null) throw new AppError("attachments 必须是最多 4 个路径的数组。", 400);
    if (body.attachments !== undefined) await this.readAttachments(attachments, principal);
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
          JSON.stringify(existing.attachments || []) !== JSON.stringify(attachments) ||
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
      if (mode === "append") {
        for (const task of await this.store.list(threadId)) if (task.turnId === targetTurnId) this.checkWorkflowAccess(task.workflow);
      }
      if (mode === "append" && !this.sessions.getTurn(threadId, targetTurnId))
        throw new AppError("追加目标不属于该会话或尚不可定位。", 409);
      try {
        await this.store.create({
          id,
          threadId,
          userId: principal?.userId || currentIdentity()?.userId,
          text,
          attachments: [...attachments],
          mode,
          targetTurnId,
          workflow: workflow.id,
          single: workflow.single === true,
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
  readAttachments(paths, principal) {
    if (paths === undefined || (Array.isArray(paths) && !paths.length)) return Promise.resolve([]);
    const read = () => readAttachments(paths, this.files);
    return this.gate ? this.gate.run(principal || this.gate.user(), read) : read();
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
    this.checkWorkflowAccess(id);
    return workflows.resolve(id, params, kbId => Boolean(this.permissionHub && effectiveKnowledgeMounts(this.config.agent, this.permissionHub).some(m => m.kbId === kbId && m.actions.includes('update'))));
  }
  checkWorkflowAccess(id) {
    const workflow = this.config.agent?.workflows?.list().find(item => item.id === id);
    const role = this.permissionHub?.context?.getStore()?.user.role || currentIdentity()?.role;
    if (workflow?.access === "admin" && role !== "admin") throw new AppError("这个工作流仅管理员可用，请联系管理员。", 403);
  }
  async ownedJob(id) {
    const job = await this.job(id);
    if (!job || (job.userId && job.userId !== currentIdentity()?.userId)) throw new AppError("任务不存在。", 404);
    this.checkWorkflowAccess(job.workflow);
    return job;
  }
  async workflowActivity(workflows) {
    const visible = workflows.filter(item => item.interactive || item.single);
    const jobs = await this.store.workflowTasks(visible.map(item => item.id));
    const result = [];
    for (const workflow of visible) {
      this.checkWorkflowAccess(workflow.id);
      const taskIds = jobs.filter(job => job.workflow === workflow.id).map(job => job.id);
      const occupied = workflow.single ? await this.store.workflowOccupancy(workflow.id) : null;
      result.push({ workflow: workflow.id, taskIds, occupant: occupied && !occupied.taskId ? { username: occupied.username, startedAt: occupied.startedAt } : null });
    }
    return result;
  }
  async feedback({ taskId, text, context, attachments = [], ...rest }) {
    if (Object.keys(rest).length) throw new AppError("意见只接受 taskId、text、context 与 attachments。", 400);
    if (this.rpc.pool && !this.rpc.current()) return this.rpc.withOwner(currentIdentity().userId, () => this.feedback({ taskId, text, context, attachments }));
    this.permissionHub?.checkAgent(this.config.agent);
    if (this.closed || this.stopping || this.failure) throw new AppError("执行服务不可用，请核对任务状态。", 503);
    requireId(taskId, "任务 ID");
    let note = requireText(text, "修改意见", 2000);
    if (context !== undefined) {
      if (!context || typeof context !== "object" || Array.isArray(context) || Object.keys(context).some(key => !["screen", "state", "label"].includes(key)) || Object.values(context).some(value => typeof value !== "string" || /[\r\n\x00-\x1f]/.test(value)))
        throw new AppError("context 只接受 screen、state、label 字符串。", 400);
      const prefix = [context.screen, context.state, context.label].filter(value => value?.trim()).join(" / ");
      if (Object.values(context).reduce((size, value) => size + [...value].length, 0) > 200 || [...prefix].length > 200) throw new AppError("屏幕上下文不能超过 200 字。", 400);
      if (prefix) note = `【当前：${prefix}】\n${note}`;
    }
    const principal = this.gate?.submission();
    const original = await this.ownedJob(taskId);
    await this.sessions.ensure(original.threadId);
    await this.readAttachments(attachments, principal);
    return this.serial(original.threadId, async () => {
      const job = await this.ownedJob(taskId);
      const workflow = this.resolve({ id: job.workflow || "chat", params: job.params ?? null });
      if (["waiting", "queued"].includes(job.status)) {
        const mode = await this.store.feedback(taskId, note, attachments);
        await this.publish(job.threadId); await this.wake(job.threadId);
        return { mode };
      }
      if (executing.includes(job.status)) {
        if (!workflow.interactive) throw new AppError("等这一步完成后再提意见。", 409);
        if (!job.turnId || this.sessions.snapshot(job.threadId).activeTurnId !== job.turnId)
          throw new AppError("当前步骤正在切换，请刷新任务状态后再提意见。", 409);
        const append = { id: randomUUID(), threadId: job.threadId, userId: job.userId,
          text: note, attachments, mode: "append", targetTurnId: job.turnId,
          workflow: job.workflow, params: job.params, agentHash: job.agentHash, createdAt: Date.now() };
        await this.store.create(append);
        await this.steer(await this.job(append.id));
        return { mode: "steer" };
      }
      const reasons = { completed: "任务已完成", cancelled: "任务已结束", failed: "任务失败", interrupted: "任务已中断", unconfirmed: "任务结果待核对", "needs-review": "任务验收待核对", replica_missing: "任务副本缺失", proposed: "任务尚未确认" };
      throw new AppError(`${reasons[job.status] || "当前任务不能接收意见"}，请先核对任务记录，再确认或新建任务。`, 409);
    });
  }
  // 一步结束后的去向：验收不通过 → needs-review（不暂停队列、不自动重试）；还有下一步 → 需要确认就 waiting，
  // 否则直接排队进入下一步；最后一步 → completed。
  async outcome(job, turn) {
    if (turn?.status !== "completed" || job.mode === "append") return { status: turn?.status, checks: null };
    try {
      const evaluate = () => this.checkOutcome(job, turn);
      return await (job.userId && this.rpc.withOwner ? this.rpc.withOwner(job.userId, evaluate) : evaluate());
    } catch (error) {
      return { status: "needs-review", checks: null, error: `Workflow 验收未完成：${error.message}` };
    }
  }
  async checkOutcome(job, turn) {
    const resolve = () => this.resolve({ id: job.workflow || "chat", params: job.params ?? null });
    // 完成通知只有 owner 身份，没有 Hub 快照；验收与派发一样，按持久化任务的 owner 重新加载权限。
    const workflow = this.permissionHub
      ? await runOwner(job.userId, () => this.permissionHub.withUser(job.userId, resolve))
      : resolve();
    const step = stepOf(workflow, job.step || 0);
    // Per-user runtime paths are already scoped; only shared runtimes need users/<id>.
    const checks = step.checks.length ? runChecks(step.checks, turn, { workspaceDir: job.userId && this.config.agent?.runtime?.workspaceDir ? (this.config.agent.runtime.ownerId === job.userId ? this.config.agent.runtime.workspaceDir : userWorkspace(this.config.agent.workspacePath || this.config.agent.runtime.workspaceDir, job.userId)) : this.config.agent?.runtime?.workspaceDir, formats: this.config.agent?.outputs?.formats }) : null;
    if (step.checks.length && !checksPassed(step.checks, checks)) return { status: "needs-review", checks };
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
        workflow: workflow.id, single: workflow.single === true, params: workflow.params, step: 0, status: "proposed", reason: why,
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
      const job = await this.ownedJob(taskId);
      if (!job || job.threadId !== threadId) throw new AppError("任务不属于该会话。", 404);
      if (job.status === "proposed") {
        const workflow = this.resolve({ id: job.workflow, params: job.params ?? null });
        if (workflow.grants.length) this.gate?.authorize(workflow.grants);
      }
      const fields = job.status === "proposed" ? { status: "queued", note } : { status: "queued", step: (job.step || 0) + 1, note, reviseCount: 0 };
      if (!(await this.store.patch(taskId, fields, ["waiting", "proposed"])))
        throw new AppError("只有等待确认的任务可以继续。", 409);
      await this.publish(threadId);
      await this.wake(threadId);
      return this.publicJob(await this.job(taskId));
    });
  }
  // 修改意见复用 note；保持当前步，派发时沿用该步的权限与模型配置。
  async revise({ threadId, taskId, text, ...rest }) {
    if (Object.keys(rest).length) throw new AppError("修改只接受 threadId、taskId 与 text。", 400);
    requireId(threadId, "会话 ID"); requireId(taskId, "任务 ID");
    const note = requireText(text, "修改意见", 2000);
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      const job = await this.ownedJob(taskId);
      if (!job || job.threadId !== threadId) throw new AppError("任务不属于该会话。", 404);
      if (job.status !== "waiting") throw new AppError("只有等待确认的任务可以按意见重做", 409);
      const reviseCount = job.reviseCount || 0;
      if (reviseCount >= 10) throw new AppError("本步已重做 10 次，请确认继续或结束任务", 409);
      if (!(await this.store.patch(taskId, { status: "queued", note, reviseCount: reviseCount + 1 }, ["waiting"])))
        throw new AppError("只有等待确认的任务可以按意见重做", 409);
      await this.publish(threadId);
      await this.wake(threadId);
      return this.publicJob(await this.job(taskId));
    });
  }
  // 只在用户核对失败结果后重排当前步骤；沿用 revise 计数和新建产物的约束。
  async retry({ threadId, taskId, text, ...rest }) {
    if (Object.keys(rest).length) throw new AppError("重新生成只接受 threadId、taskId 与 text。", 400);
    requireId(threadId, "会话 ID"); requireId(taskId, "任务 ID");
    const note = text == null || text === '' ? null : requireText(text, "修改意见", 2000);
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      const job = await this.ownedJob(taskId);
      if (job.threadId !== threadId) throw new AppError("任务不属于该会话。", 404);
      if (job.workflow === 'chat' || !job.workflow) throw new AppError("普通对话不能重新生成工作流步骤。", 409);
      const allowed = ['failed', 'interrupted', 'needs-review', 'unconfirmed'];
      if (!allowed.includes(job.status)) throw new AppError("只有失败、中断、验收未过或待核对的步骤可以重新生成。", 409);
      const reviseCount = job.reviseCount || 0;
      if (reviseCount >= 10) throw new AppError("本步已重做 10 次，请确认继续或结束任务", 409);
      if (!(await this.store.patch(taskId, { status: 'queued', note, reviseCount: reviseCount + 1, error: null, checks: null, turnId: null }, allowed)))
        throw new AppError("任务状态已变化，请刷新后核对。", 409);
      await this.store.pause(threadId, false);
      await this.publish(threadId);
      await this.wake(threadId);
      return this.publicJob(await this.job(taskId));
    });
  }
  // 异常 single 任务由人明确结束；两种定位方式共用仓储状态校验、审计与发布。
  async cancel(input) {
    const { threadId, taskId, workflow, startedAt, takeover, ...rest } = input;
    const byWorkflow = Object.hasOwn(input, 'workflow') || Object.hasOwn(input, 'startedAt');
    if (Object.keys(rest).length || (takeover !== undefined && typeof takeover !== 'boolean')) throw new AppError("结束任务只接受 threadId、taskId、takeover，或 workflow、startedAt、takeover。", 400);
    if (byWorkflow) {
      if (Object.hasOwn(input, 'threadId') || Object.hasOwn(input, 'taskId') || takeover !== true || typeof workflow !== 'string' || !workflow || typeof startedAt !== 'number' || !Number.isFinite(startedAt))
        throw new AppError("按工作流接管必须提供 workflow、startedAt 和 takeover:true，不能混用 threadId、taskId。", 400);
    } else { requireId(threadId, "会话 ID"); requireId(taskId, "任务 ID"); }
    if (takeover === true) {
      if (currentIdentity()?.role !== 'admin') throw new AppError("只有管理员可以接管结束任务。", 403);
      this.permissionHub?.checkAgent(this.config.agent);
      const workflows = this.config.agent?.workflows?.list().filter(item => item.single && item.access === 'admin').map(item => item.id) || [];
      if (byWorkflow && !workflows.includes(workflow)) throw new AppError("任务不存在或不允许接管结束", 404);
      const job = byWorkflow ? await this.store.cancelTakeoverWorkflow(workflow, startedAt, workflows) : await this.store.cancelTakeover(threadId, taskId, workflows);
      await runOwner(job.userId, async () => this.permissionHub
        ? this.permissionHub.run(await this.permissionHub.snapshot(job.userId, { allowDisabled: true }), () => this.publish(job.threadId))
        : this.publish(job.threadId));
      return { status: 'cancelled' };
    }
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      const job = await this.ownedJob(taskId);
      if (!job || job.threadId !== threadId) throw new AppError("任务不属于该会话。", 404);
      if (!(await this.store.patch(taskId, { status: "cancelled" }, cancellable(job.single))))
        throw new AppError("只有排队、等待确认、提议或异常待核对的 single 任务可以结束；请先核对任务状态。", 409);
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
          if (this.runtimeTimers.has(id) || (this.config.sharding && !await this.config.sharding.canDispatch(ownerId))) continue;
          const dispatch = () => this.serial(id, () => this.rpc.withOwner ? this.rpc.withOwner(ownerId, () => this.dispatch(id)) : this.dispatch(id));
          try { await (ownerId ? runOwner(ownerId, () => this.permissionHub ? this.permissionHub.withUser(ownerId, dispatch) : dispatch()) : dispatch()); }
          catch (error) {
            if (this.rpc.pool) {
              // 运行环境容量不足/单个用户启动失败不能停止其他 owner 的派发。
              if (this.runtimeBusy(error)) this.retryRuntime(id, error);
              else await runOwner(ownerId, () => this.failOwner(ownerId, error));
            } else throw error;
          }
        }
      }).catch(error => this.fail(error));
    });
  }
  async dispatch(threadId) {
    if (this.config.sharding && !await this.config.sharding.canDispatch(currentIdentity().userId)) return;
    if (this.closed || this.stopping || this.failure || (await this.store.paused(threadId)))
      return;
    if (!this.sessions.sessions.has(threadId)) {
      try {
        await this.sessions.ensure(threadId);
      } catch (error) {
        if (this.runtimeBusy(error)) { this.retryRuntime(threadId, error); return; }
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
    const maxConcurrentTurns = Math.min(2, this.config.deployment?.maxConcurrentTurns ?? 2);
    if (running.size >= maxConcurrentTurns) return;
    const ownedRunning = new Set((await (this.store.allPending?.() || this.store.list(null, { history: false })))
      .filter(item => item.userId === job.userId && executing.includes(item.status)).map(item => item.threadId));
    for (const [id, session] of this.sessions.sessions) if (session.ownerId === job.userId && session.activeTurnId) ownedRunning.add(id);
    const entitlement = await this.permissionHub?.plan(job.userId, ownedRunning.size);
    if (entitlement?.concurrencyBlocked) return;
    const legacyBudget = await this.usage?.budgetStatus();
    const budget = entitlement?.exceeded ? entitlement : legacyBudget;
    if (budget?.exceeded) {
      this.retryBudget(threadId, budget);
      await this.publish(threadId);
      return;
    }
    clearTimeout(this.budgetTimers.get(threadId));
    this.budgetTimers.delete(threadId);
    if (this.permissionHub) {
      try { await this.sessions.beforeTurn?.(); }
      catch (error) { if (this.runtimeBusy(error)) { this.retryRuntime(threadId, error); return; } throw error; }
    }
    if (!this.permissionHub && !(await this.store.patch(job.id, { status: "starting", selectedModel: null, modelSource: null }, ["queued"])))
      return;
    await this.publish(threadId);
    let sent = false, gateStarted = false;
    try {
      const workflow = this.resolve({ id: job.workflow || "chat", params: job.params ?? null });
      const step = stepOf(workflow, job.step || 0);
      // 第二步起不重发原文：会话历史里已有原始要求，这里只说明用户已确认，并带上补充说明。
      const extra = job.note ? `\n用户补充：${job.note}` : "";
      let input = step.index ? `用户已确认上一步，请继续。${extra}` : `${job.text}${extra}`;
      if (job.reviseCount > 0)
        input = `这是第 ${job.reviseCount} 次按用户意见重做本步，用户的修改意见是：${job.note}；保留已确认的部分，只按意见修改；新产物使用新文件名（产物只能新建、不能覆盖），不要覆盖之前的版本。`;
      if (job.mode === "append") {
        const original = this.sessions
          .getTurn(threadId, job.targetTurnId)
          ?.messages.map((m) => m.text)
          .join("\n")
          .slice(0, 6000);
        input = `这是对本会话先前任务（turn ID: ${job.targetTurnId}）的补充。${original ? `\n目标任务的用户要求（引用）：\n${original}\n` : "\n"}本次补充要求：\n${job.text}`;
      }
      await this.sessions.atBoundary(async () => {
        if (this.config.sharding && !await this.config.sharding.canDispatch(job.userId)) return;
        if (this.closed || this.stopping || this.failure) {
          const error = new Error("服务已关闭或连接失效。");
          // 请求还没发出；关闭期间保留排队，重启后可安全派发。
          if (this.stopping || this.closed) error.uncertain = true;
          throw error;
        }
        let prepared = await this.sessions.prepareInput(
          threadId,
          input,
          job.agentHash,
          workflow.id === "chat" ? null : workflow,
          step.index,
        );
        if (this.permissionHub) {
          // 在边界内、queued→starting 之前再读权益；等待工具刷新期间的降级不能绕过配额。
          const rows = await (this.store.allPending?.() || this.store.list(null, { history: false }));
          const active = new Set(rows.filter(r => r.userId === job.userId && executing.includes(r.status)).map(r => r.threadId));
          for (const [id, session] of this.sessions.sessions) if (session.ownerId === job.userId && session.activeTurnId) active.add(id);
          const latest = await this.permissionHub.plan(job.userId, active.size);
          if (latest.exceeded) { this.retryBudget(threadId, latest); return; }
          if (latest.concurrencyBlocked) return;
          if (!(await this.store.patch(job.id, { status: 'starting', selectedModel: null, modelSource: null }, ['queued']))) return;
        }
        // 领取后再读取意见，包含 prepareInput 等待期间到达的反馈；starting 不再接受排队意见。
        const feedback = (await this.job(job.id)).feedback || [];
        if (feedback.length) prepared = [...prepared, { type: "text", text: feedback.map(item => item.text).join("\n"), text_elements: [] }];
        // 按实际读取结果判断能力，并复用附件内容；后续步骤不重发首步附件。
        const attachments = [];
        if (step.index === 0 && job.attachments?.length)
          attachments.push(await this.readAttachments(job.attachments));
        for (const item of feedback) if (item.attachments?.length)
          attachments.push(await this.readAttachments(item.attachments));
        const hasImage = attachments.some(group => group.some(file => file.image));
        // 优先级：步骤 > 任务 > 默认；预算只替换场景或默认选择，能力要求继续生效。
        const router = this.config.launch.router;
        let selection = step.model || job.model || null;
        let modelSource = step.model ? "步骤指定" : job.model ? "任务指定" : "默认路由";
        if (router && budget?.downgraded && !selection?.includes("/")) {
          selection = budget.downgradeScene;
          modelSource = "预算降级";
        }
        if (selection) modelSource += `：${selection.includes("/") ? "" : "场景 "}${selection}`;
        let chosen;
        try { chosen = router?.resolve({ model: selection, needs: hasImage ? { ...step.needs, image: true } : step.needs }); }
        catch (error) {
          if (hasImage && error.code === "MODEL_UNAVAILABLE") {
            if (selection?.includes("/") && !(this.config.registry?.models[selection]?.inputs || ["text"]).includes("image"))
              throw new AppError(`这一步指定的模型 ${selection} 不支持看图，不能处理图片。请改用能看图的模型，或去掉图片后重试。`, error.status, error.code);
            throw new AppError("这一步带有图片，但没有可用的能看图的模型。请在 config/models.json 为支持图片输入的模型标注 inputs 并启用它，或去掉图片后重试。", error.status, error.code);
          }
          throw error;
        }
        if (chosen) validateEffort(chosen, step.effort);
        const model = chosen?.id || this.config.launch.model || this.sessions.snapshot(threadId).model || "unknown";
        for (const group of attachments)
          prepared = attachInput(prepared, group, chosen?.spec || this.config.registry?.models[model]);
        if (chosen && hasImage) modelSource += "（含图片，已选能看图的模型）";
        await this.store.patch(job.id, { selectedModel: model, modelSource });
        await this.publish(threadId);
        this.gate?.start(job, workflow.grants, step.writes);
        gateStarted = true;
        this.sessions.prepareUsage(threadId, { model, taskId: job.id });
        if (!this.rpc.pool) sent = true;
        const result = await this.rpc.request("turn/start", {
          threadId,
          clientUserMessageId: job.id,
          input: prepared,
          ...(router ? { model, effort: step.effort || chosen.spec.defaultReasoningLevel || null } : {}),
        }, { onSent: () => { sent = true; } });
        const turn = this.sessions.recordTurn(threadId, result.turn);
        await this.bind(job.id, result.turn.id);
        this.sessions.publish(threadId, turn);
      });
    } catch (error) {
      // 只结束本任务自己开启的权限上下文；取得权限与发出 RPC 是两个边界。
      if (gateStarted) this.gate?.end(threadId);
      await this.executionError(job, error, sent);
    } finally {
      this.sessions.finishUsageStart(threadId);
    }
    await this.publish(threadId);
  }
  runtimeBusy(error) { return ['RUNTIME_BUSY', 'HUB_RESTART_PENDING'].includes(error.code); }
  retryRuntime(threadId, error) {
    if (this.runtimeTimers.has(threadId) || this.closed || this.stopping || this.failure) return;
    const seconds = Number(error.retryAfter);
    const timer = setTimeout(() => {
      this.runtimeTimers.delete(threadId);
      if (!this.closed && !this.stopping && !this.failure) this.schedule(threadId);
    }, (Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000);
    timer.unref();
    this.runtimeTimers.set(threadId, timer);
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
      const context = this.gate?.forTurn(job.threadId, job.targetTurnId);
      let input = context && this.permissionHub
        ? await this.gate.run(context, () => this.config.agent.input(job.text))
        : await this.sessions.prepareInput(job.threadId, job.text, job.agentHash);
      const original = (await this.store.list(job.threadId)).find(item => item.turnId === job.targetTurnId && item.selectedModel);
      const model = original?.selectedModel || this.sessions.snapshot(job.threadId).model;
      if (job.attachments?.length)
        input = attachInput(input, await this.readAttachments(job.attachments), this.config.registry?.models[model] || this.config.launch.router?.resolve({ model }).spec);
      await this.store.patch(job.id, { selectedModel: model,
        modelSource: "沿用当前轮次" });
      if (!this.rpc.pool) sent = true;
      const result = await this.rpc.request("turn/steer", {
        threadId: job.threadId,
        expectedTurnId: job.targetTurnId,
        clientUserMessageId: job.id,
        input,
      }, { onSent: () => { sent = true; } });
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
    if (!sent && (this.runtimeBusy(error) || this.closed || this.stopping)) {
      // 先阻止重复唤醒，再回到 queued（PG patch 会发布 outbox）。未发送的任务可安全重试。
      this.retryRuntime(job.threadId, error);
      await this.store.patch(job.id, { status: 'queued', error: null, selectedModel: null, modelSource: null }, ['queued', 'starting', 'steering'], { restoreUnsent: true });
      return;
    }
    const knownRejection = Number.isInteger(error.code);
    // Hub may reject prepareInput before queued→starting; preserve terminal outcomes from late callbacks.
    await this.store.patch(job.id, {
      status:
        sent && (error.uncertain || !knownRejection) ? "unconfirmed" : "failed",
      error: error.message,
    }, sent ? ['starting', 'running', 'steering'] : ['queued', 'starting', 'running', 'steering']);
    await this.store.pause(job.threadId);
  }
  async patchOutcome(job, fields, expected) {
    if (fields.status && !executing.includes(fields.status)) fields = { ...fields, feedback: [] };
    // 正常完成与提前完成都从这里推进；重做意见不能泄漏到下一步。
    if (fields.step !== undefined && fields.step !== (job.step || 0))
      fields = { ...fields, reviseCount: 0, ...(job.reviseCount > 0 ? { note: null } : {}) };
    try { return await this.store.patch(job.id, fields, expected); }
    catch (error) {
      if (error.code !== 'QUEUE_FULL' || fields.status !== 'queued') throw error;
      // Completion must not kill the executor when the next workflow step cannot queue.
      return this.store.patch(job.id, { ...fields, status: 'waiting', step: job.step || 0, note: job.note, reviseCount: job.reviseCount || 0,
        error: '全局排队已满；容量释放后请确认下一步。' }, expected);
    }
  }
  async bind(id, turnId) {
    if (this.closed || this.stopping || this.failure) return;
    const job = await this.job(id),
      turn = this.sessions.getTurn(job.threadId, turnId);
    const ended = terminal.includes(turn?.status);
    if (ended) await this.sessions.persistTurn?.(job.threadId, turn);
    const { status, checks, step: next, error } = ended ? await this.outcome(job, turn) : { status: "running", checks: null };
    if (
      !(await this.patchOutcome(
        job,
        { turnId, status, error: error || turn?.error || null, checks, ...(next !== undefined ? { step: next } : {}) },
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
    if (this.config.generation) { try { this.config.generation.assert(); } catch { return; } }
    clearTimeout(this.timers.get(turn.id));
    this.timers.delete(turn.id);
    await this.sessions.persistTurn?.(threadId, turn);
    for (const job of await this.store.list(threadId))
      if (job.turnId === turn.id && executing.includes(job.status)) {
        const { status, checks, step, error } = await this.outcome(job, turn);
        await this.patchOutcome(
          job,
          { status, error: error || turn.error || null, checks, ...(step !== undefined ? { step } : {}) },
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
    this.permissionHub?.checkAgent(this.config.agent);
    if (this.closed || this.stopping || this.failure)
      throw new AppError("请先重启执行服务，再核对状态。", 503);
    await this.sessions.ensure(threadId);
    return this.serial(threadId, async () => {
      for (const job of await this.store.list(threadId)) this.checkWorkflowAccess(job.workflow);
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
  async snapshot(threadId, { checkAccess = true } = {}) {
    const all = await this.store.list(threadId),
      unfinished = all.filter((j) => !terminal.includes(j.status)),
      queued = unfinished.filter((j) => j.status === "queued");
    const ordered = [
      ...unfinished.filter((j) => j.status !== "queued"),
      ...queued.filter((j) => j.mode === "append"),
      ...queued.filter((j) => j.mode !== "append"),
      ...all.filter((j) => terminal.includes(j.status)).slice(-20),
    ];
    if (checkAccess) for (const job of ordered) this.checkWorkflowAccess(job.workflow);
    return {
      threadId,
      paused: await this.store.paused(threadId),
      budget: await this.usage?.budgetStatus() || { exceeded: false, reason: null, resetsAt: null },
      jobs: ordered.map((j) => this.publicJob(j)),
    };
  }
  async publish(threadId) {
    this.hub.publish("queue", await this.snapshot(threadId, { checkAccess: false }), threadId, currentIdentity()?.userId || this.sessions.sessions.get(threadId)?.ownerId);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.runtimeTimers.values()) clearTimeout(timer);
    this.runtimeTimers.clear();
    for (const timer of this.budgetTimers.values()) clearTimeout(timer);
    this.budgetTimers.clear();
    this.sessions.off("turnCompleted", this.onCompleted);
    this.sessions.off("usageError", this.onFatal);
    this.rpc.off("fatal", this.onFatal);
    await Promise.allSettled([...this.locks.values()]);
    await this.drain;
    if (!this.config.generation) await this.store.recover(
      "服务关闭时尚未确认结果，请查看历史，不会自动重发。",
    );
  }
}
