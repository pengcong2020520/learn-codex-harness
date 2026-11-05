import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../../../shared/errors.mjs';

const covers = (root, value) => value === root || value.startsWith(root + '/');
const denied = () => { throw new AppError('未授权的资源、动作或执行范围。', 403, 'FORBIDDEN'); };

// One policy evaluator. Contexts can only be minted by this server; JSON tool arguments are never identities.
export class PermissionGate {
  #contexts = new WeakSet();
  #storage = new AsyncLocalStorage();
  constructor({ scope, agent }) { Object.assign(this, { scope, agent }); this.runs = new Map(); }
  issue(fields) {
    const context = Object.freeze({ ...fields, ownerId: this.scope.ownerId, agentId: this.agent.definition.agent.id });
    this.#contexts.add(context); return context;
  }
  operator() { return this.issue({ kind: 'operator' }); }
  async run(context, operation, signal) {
    if (!this.#contexts.has(context)) denied();
    return this.#storage.run({ context, signal }, operation);
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
  start(job) {
    if (this.runs.has(job.threadId)) denied();
    const controller = new AbortController();
    const context = this.issue({ kind: 'task', taskId: job.id, threadId: job.threadId,
      maintenanceKb: job.knowledge?.kbId || null, signal: controller.signal });
    this.runs.set(job.threadId, { context, controller, turnId: null });
  }
  started(threadId, turnId) { const run = this.runs.get(threadId); if (run && !run.turnId) run.turnId = turnId; }
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
    const mount = (this.agent.definition.agent.knowledge || []).find(m => m.kbId === kbId);
    if (!mount || !mount.actions.includes(action)) denied();
    if (action !== 'read' && context.kind === 'task' && context.maintenanceKb !== kbId) denied();
    return mount;
  }
  check(action, target = {}) {
    const context = this.current();
    if (!['read','create','list','update','index','tool.call'].includes(action)) denied();
    if (target.ownerId && target.ownerId !== context.ownerId) denied();
    if (action === 'tool.call') { if (!this.agent.allowsTool(target.name)) denied(); return; }
    if (target.kbId) return this.mount(target.kbId, action);
    if (typeof target.path === 'string') {
      const locator = target.path;
      if (locator.includes('..') || locator.includes('\\') || locator.startsWith('/')) denied();
      for (const [kbId, binding] of Object.entries(this.knowledgeBases || this.agent.definition.bindings.knowledgeBases || {})) {
        if (covers(binding.wikiRoot, locator)) denied();
        if (covers(binding.sourceRoot, locator)) this.mount(kbId, 'read');
      }
      const permission = action === 'list' ? 'read' : action;
      const found = this.agent.sources.some(s => s.actions.includes(permission) &&
        (covers(s.locator, locator) || (action === 'list' && (!locator || covers(locator, s.locator)))));
      if (!found && !(action === 'create' && covers(this.agent.outputs.directory, locator))) denied();
      return;
    }
    denied();
  }
  // This is called for authenticated product input, before a durable job is created.
  maintenance(value) {
    if (value == null) return null;
    if (Object.keys(value).sort().join(',') !== 'kbId,operation' || value.operation !== 'update') denied();
    this.mount(value.kbId, 'update');
    return { kbId: value.kbId, operation: 'update' };
  }
}
