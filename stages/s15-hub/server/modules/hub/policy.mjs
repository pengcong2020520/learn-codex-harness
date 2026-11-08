import { AppError } from '../../../shared/errors.mjs';
export const ACTIONS = Object.freeze(['use', 'read', 'modify', 'share', 'delete']);
export const PLANS = Object.freeze({
  basic: { id: 'basic', name: 'basic', agents: ['writing'], tool_groups: ['files', 'knowledge'], daily_tokens: 200000, max_concurrent_turns: 1, max_knowledge_bases: 3, max_private_skills: 3 },
  pro: { id: 'pro', name: 'pro', agents: ['*'], tool_groups: ['*'], daily_tokens: 1000000, max_concurrent_turns: 2, max_knowledge_bases: 20, max_private_skills: 20 },
});
const includes = (values, id) => values?.includes('*') || values?.includes(id);
export const owns = (user, resource) => Boolean(resource && (resource.owner_id ?? resource.ownerId) === (user.id ?? user.userId));
export function decision(user, action, resource) {
  if (!ACTIONS.includes(action)) throw new AppError('未知权限动作。', 400);
  if (!user || user.disabled_at || !resource) return 404;
  // 会话、普通文件仍属于个人隔离边界；admin 不借 Hub 进入别人的会话。
  if (resource.type === 'personal') return owns(user, resource) ? 200 : 404;
  if (user.role === 'admin') return 200;
  const scope = resource.scope ?? resource.visibility ?? 'private';
  const owner = owns(user, resource);
  const granted = user.grants?.includes(`${resource.type}:${resource.id}`);
  const visible = owner || scope === 'system' || (scope === 'shared' && granted);
  if (!visible) return 404;
  const plan = user.plan || PLANS.basic;
  if (resource.type === 'agent' && !includes(plan.agents, resource.planId || resource.id)) return 404;
  if (resource.type === 'tool_group' && !includes(plan.tool_groups, resource.id)) return 404;
  if (resource.type === 'knowledge' && action === 'delete' && owner) return 200;
  return ['use', 'read'].includes(action) || (scope !== 'system' && owner) ? 200 : 403;
}
export function can(user, action, resource) {
  const status = decision(user, action, resource);
  if (status !== 200) throw new AppError(status === 404 ? '资源不存在或未授权。' : '没有执行这个动作的权限。', status, 'HUB_DENIED');
  return true;
}
export function effectiveTools(user, agent, groups) {
  return [...new Set(groups.filter(group => decision(user, 'use', { ...group, type: 'tool_group' }) === 200)
    .flatMap(group => group.tools).filter(name => agent.tools.allow.includes(name)))];
}
export function quota(user, used, active, resetsAt) {
  const plan = user.plan || PLANS.basic;
  return { exceeded: user.role !== 'admin' && used >= plan.daily_tokens,
    concurrencyBlocked: active >= 2 || (user.role !== 'admin' && active >= plan.max_concurrent_turns),
    used, limit: user.role === 'admin' ? null : plan.daily_tokens, resetsAt,
    reason: `今日 token 已用 ${used}，上限 ${plan.daily_tokens}` };
}
