import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../../../shared/errors.mjs';

const storage = new AsyncLocalStorage();
export const currentIdentity = () => storage.getStore();
export function requireIdentity() {
  const identity = currentIdentity();
  if (!identity?.userId) throw new AppError('请运行 npm run login 重新登录。', 401, 'UNAUTHENTICATED');
  return identity;
}
export function runIdentity(identity, operation) {
  if (!identity?.userId) throw new Error('缺少可信 owner。');
  return storage.run(Object.freeze({ userId: identity.userId, role: identity.role, authSessionId: identity.authSessionId, authorization: identity.authorization }), operation);
}
// 后台调用者必须从持久化任务/会话记录传 owner，不继承触发调度的请求身份。
export const runOwner = (ownerId, operation) => runIdentity({ userId: ownerId }, operation);
export function requestScope(instanceId) {
  return { instanceId, get ownerId() { return requireIdentity().userId; } };
}
