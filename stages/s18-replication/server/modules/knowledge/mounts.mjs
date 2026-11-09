// First declared knowledge mount is the default for user-created KBs only.
// Static KBs omitted from an Agent remain inaccessible, even to an admin.
export function declaredKnowledgeMounts(agent, resources = []) {
  const mounts = agent.definition.agent.knowledge || [];
  const fallback = mounts[0];
  if (!fallback) return mounts;
  const ids = new Set(mounts.map(m => m.kbId));
  return [...mounts, ...resources.filter(r => r.type === 'knowledge' && r.user_created && !ids.has(r.id))
    .map(r => ({ ...fallback, kbId: r.id }))];
}
export function effectiveKnowledgeMounts(agent, hub) {
  if (!hub) return agent.definition.agent.knowledge || [];
  const visible = new Map(hub.visible().filter(r => r.type === 'knowledge').map(r => [r.id, r]));
  return declaredKnowledgeMounts(agent, [...hub.current().resources.values()])
    .filter(m => visible.has(m.kbId))
    .map(m => ({ ...m, actions: m.actions.filter(a => a === 'read' || visible.get(m.kbId).actions.includes('modify')) }));
}
