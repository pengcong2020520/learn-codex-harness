import { effectiveKnowledgeMounts } from '../knowledge/mounts.mjs';
import { can } from '../hub/policy.mjs';
import { runIdentity, currentIdentity } from '../accounts/context.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../../../shared/errors.mjs';

const covers = (root, value) => value === root || value.startsWith(root + '/');
const denied = () => { throw new AppError('未授权的资源、动作或执行范围。', 403, 'FORBIDDEN'); };

// One policy evaluator. Contexts can only be minted by this server; JSON tool arguments are never identities.
export class PermissionGate {
  #contexts = new WeakSet();
  #storage = new AsyncLocalStorage();
  constructor({ scope, agent, permissionHub }) { Object.assign(this, { scope, agent, permissionHub }); this.runs = new Map(); }
  issue(fields) {
    const ownerId = fields.ownerId || fields.userId || this.scope.ownerId;
    const context = Object.freeze({ threadId: null, turnId: null, ...fields, userId: ownerId, ownerId, agentId: this.agent.definition.agent.id, policy: fields.policy || this.permissionHub?.context.getStore() });
    this.#contexts.add(context); return context;
  }
  // 持久化媒体任务只授权其预先通过 create 检查的单个路径，不延长原轮次授权。
  media(job) {
    if (job.agentId !== this.agent.definition.agent.id) denied();
    return this.issue({ kind: 'media', ownerId: job.ownerId || job.context.userId, path: job.path, threadId: job.context.threadId, turnId: job.context.turnId, taskId: job.context.taskId });
  }
  operator(ownerId) { return this.issue({ kind: 'operator', ownerId }); }
  user() { return this.issue({ kind: 'user' }); }
  submission() { return this.#storage.getStore() ? this.current() : this.user(); }
  async run(context, operation, signal) {
    if (!this.#contexts.has(context)) denied();
    const execute = () => runIdentity({ ...(currentIdentity()?.userId === context.ownerId ? currentIdentity() : {}), userId: context.ownerId }, () => this.#storage.run({ context, signal }, operation));
    return this.permissionHub && context.policy ? this.permissionHub.run(context.policy, execute) : execute();
  }
  current() {
    const state = this.#storage.getStore();
    const context = state?.context;
    state?.signal?.throwIfAborted();
    if (!context || !this.#contexts.has(context)) denied();
    this.agent.assertCurrent();
    context.signal?.throwIfAborted();
    if (context.kind === 'task' && this.runs.get(context.threadId)?.context !== context) denied();
    return context;
  }
  // grants 与 writes 来自 workflow 解析结果，只在本任务（当前步骤）的上下文里有效；writes 为 null 表示不收窄。
  start(job, grants = [], writes = null) {
    if (this.runs.has(job.threadId)) denied();
    const controller = new AbortController();
    const context = this.issue({ kind: 'task', ownerId: job.userId, taskId: job.id, threadId: job.threadId,
      grants: Object.freeze(grants.map(grant => Object.freeze({ ...grant }))), writes: writes ? Object.freeze([...writes]) : null, signal: controller.signal });
    this.runs.set(job.threadId, { context, controller, turnId: null });
  }
  started(threadId, turnId) {
    const run = this.runs.get(threadId);
    if (run && !run.turnId && typeof turnId === 'string' && turnId) {
      run.turnId = turnId; run.context = this.issue({ ...run.context, turnId });
    }
  }
  forTurn(threadId, turnId) {
    const run = this.runs.get(threadId);
    if (!run || run.turnId !== turnId || run.controller.signal.aborted) denied();
    return run.context;
  }
  end(threadId, turnId) {
    const run = this.runs.get(threadId);
    if (run && (!turnId || run.turnId === turnId)) {
      run.controller.abort(new Error('任务已结束。')); this.runs.delete(threadId);
    }
  }
  close() { for (const id of this.runs.keys()) this.end(id); }
  mount(kbId, action = 'read') {
    const context = this.current();
    this.permissionHub?.checkResource('knowledge', kbId, action === 'read' ? 'read' : 'modify');
    const mount = effectiveKnowledgeMounts(this.agent, this.permissionHub).find(m => m.kbId === kbId);
    if (!mount || !mount.actions.includes(action)) denied();
    if (action !== 'read' && context.kind === 'task' && !context.grants.some(g => g.type === 'knowledge.update' && g.kbId === kbId)) denied();
    return mount;
  }
  bindings() {
    const bindings = { ...(this.knowledgeBases || this.agent.definition.bindings.knowledgeBases || {}) };
    if (this.permissionHub) for (const r of this.permissionHub.current().resources.values())
      if (r.type === 'knowledge') bindings[r.id] = { sourceRoot: r.source_root, wikiRoot: r.wiki_root };
    return bindings;
  }
  check(action, target = {}) {
    const context = this.current();
    if (!['read','create','list','update','index','tool.call'].includes(action)) denied();
    if (target.ownerId && (!target.kbId || !this.permissionHub)) can({ id: context.ownerId }, 'read', { type: 'personal', owner_id: target.ownerId });
    if (context.kind === 'media' && !((action === 'create' && target.path === context.path) || (action === 'tool.call' && target.name === 'generate_video'))) denied();
    if (action === 'tool.call') { if (context.kind === 'media') { if (!this.agent.allowsTool(target.name)) denied(); return; } if (this.permissionHub) this.permissionHub.checkTool(target.name, this.agent); else if (!this.agent.allowsTool(target.name)) denied(); return; }
    if (target.kbId) return this.mount(target.kbId, action);
    if (typeof target.path === 'string') {
      const locator = target.path;
      if (locator.includes('..') || locator.includes('\\') || locator.startsWith('/')) denied();
      for (const [kbId, binding] of Object.entries(this.bindings())) {
        if (covers(binding.wikiRoot, locator)) denied();
        if (covers(binding.sourceRoot, locator)) { if (!['read','list'].includes(action)) denied(); this.mount(kbId, 'read');
          // A dynamic knowledge mount grants its source tree read-only even if a static dataBinding is narrower.
          if (this.permissionHub?.resource('knowledge', kbId)?.user_created) return;
        }
      }
      if (action === 'create' && context.kind === 'task' && context.writes && !context.writes.some(root => covers(root, locator))) denied();
      const permission = action === 'list' ? 'read' : action;
      const found = this.agent.sources.some(s => s.actions.includes(permission) &&
        (covers(s.locator, locator) || (action === 'list' && (!locator || covers(locator, s.locator)))));
      if (!found && !(action === 'create' && covers(this.agent.outputs.directory, locator))) denied();
      return;
    }
    denied();
  }
  // 提交任务时（任务入库之前）核对 workflow 申请的额外授权确实在 Agent 能力之内。
  authorize(grants) {
    for (const grant of grants) {
      if (grant.type !== 'knowledge.update') denied();
      this.mount(grant.kbId, 'update');
    }
    return grants;
  }
}
