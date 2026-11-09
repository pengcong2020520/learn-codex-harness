import { can } from '../hub/policy.mjs';
import { EventEmitter } from 'node:events';
import { currentIdentity, requireIdentity, runOwner } from '../accounts/context.mjs';
import { busyError } from './pool.mjs';
import { AppError } from '../../../shared/errors.mjs';

export function assertToolOwner(connectionOwner, task, session) {
  if (!task || task.userId !== connectionOwner || session?.ownerId !== connectionOwner)
    throw new AppError('工具回调的连接用户与任务 owner 不一致。', 403, 'RUNTIME_OWNER_MISMATCH');
}
// 保留既有 RPC 接口，身份只能来自认证上下文或持久化记录；没有默认 admin 回退。
export class RuntimeRouter extends EventEmitter {
  constructor(pool, { isolated = false } = {}) { super(); this.pool = pool; this.isolated = isolated; }
  current() { return this.pool.current(requireIdentity().userId); }
  withOwner(owner, operation) { return runOwner(owner, () => this.pool.withOwner(owner, operation)); }
  async request(method, params, { onSent } = {}) {
    this.generation?.assert();
    const owner = requireIdentity().userId;
    if (params?.threadId && this.ownerOf) {
      const recorded = await this.ownerOf(params.threadId);
      can({ id: owner }, 'use', { type: 'personal', owner_id: recorded });
    }
    return this.pool.withOwner(owner, value => {
      if (value.rpc.closing) throw busyError();
      // 只有原生连接实际写出请求才标记 sent；owner 校验、租约和 closing 都是发送前检查。
      return value.rpc.request(method, params, { onSent });
    });
  }
  attach(value, owner) {
    value.rpc.on('notification', message => {
      if (this.accepting === false) return;
      try { this.generation?.assert(); } catch { return; }
      if (value.rpc.closing || this.pool.entries.get(owner)?.state !== 'ready') return;
      const thread = message.params?.threadId;
      // thread/start 的早到通知没有会话记录，SessionService 原本也会忽略。
      const session = thread && this.sessions?.sessions.get(thread);
      if (session && session.ownerId !== owner) return;
      runOwner(owner, () => this.emit('notification', { ...message, runtimeOwner: owner }));
    });
  }
  agent(base) {
    const router = this;
    return new Proxy(base, { get(target, key) {
      const owner = currentIdentity()?.userId;
      const current = owner && router.pool.current(owner)?.agent;
      if (!current && router.isolated) throw busyError();
      const agent = current || target;
      const value = Reflect.get(agent, key);
      return typeof value === 'function' ? value.bind(agent) : value;
    } });
  }
  close() { return this.pool.close(); }
}
