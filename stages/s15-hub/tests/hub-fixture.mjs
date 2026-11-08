// Test double only. Real PostgreSQL constraints have a separate external suite.
import { Hub } from '../server/modules/hub/index.mjs';
import { PLANS } from '../server/modules/hub/policy.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
export function hubFixture() {
  const state = { users: ['alice','bob','carol','dave'].map((username, i) => ({ id: username, username, role: i ? 'user' : 'admin', plan_id: 'basic', disabled_at: null })),
    knowledge: [{ id: 'general', owner_id: 'bob', visibility: 'private', source_root: 'inputs/general', wiki_root: 'research/general/wiki' }], skills: [], grants: [], requests: [], events: [], usage: [] };
  const result = rows => ({ rows, rowCount: rows.length });
  const pool = { async connect() { return { query: pool.query, release() {} }; }, async query(sql, values = []) {
    const [, a, b, c, d, e, f] = values;
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql) || sql.includes('pg_advisory_xact_lock')) return result([]);
    if (sql.includes('row_to_json(p)')) return result(state.users.filter(u => u.id === a).map(u => ({ ...u, plan: PLANS[u.plan_id] })));
    if (sql.startsWith('SELECT id FROM agent_data.plans')) return result(PLANS[values[0]] ? [{ id: values[0] }] : []);
    if (sql.startsWith('SELECT coalesce(sum(total_tokens)')) return result([{ n: state.usage.filter(r => r.owner === a && r.time >= +b && r.time < +c).reduce((n, r) => n + r.tokens, 0) }]);
    if (sql.startsWith('SELECT k.*')) return result(state.knowledge.map(r => ({ ...r, owner: r.owner_id })));
    if (sql.startsWith('SELECT s.*')) return result(state.skills.map(r => ({ ...r, owner: r.owner_id })));
    if (sql.startsWith('SELECT resource_type,resource_id')) return result(state.grants.filter(g => g.grantee_id === a));
    if (sql.startsWith('SELECT * FROM agent_data.knowledge_bases')) return result(state.knowledge.filter(r => r.id === a));
    if (sql.startsWith('SELECT * FROM agent_data.hub_skills')) return result(state.skills.filter(r => r.id === a));
    if (sql.startsWith('SELECT grantee_id')) return result(state.grants.filter(g => g.resource_type === a && g.resource_id === b));
    if (sql.startsWith('SELECT id,username,disabled_at')) return result(state.users.filter(u => a.includes(u.username)));
    if (sql.startsWith('SELECT id FROM agent_data.users') || sql.startsWith('SELECT id,plan_id')) return result(state.users.filter(u => u.username === a));
    if (sql.startsWith('SELECT username FROM agent_data.users')) return result(state.users.filter(u => a.includes(u.id)));
    if (sql.startsWith('SELECT count(*)')) return result([{ n: (sql.includes('hub_skills') ? state.skills : state.knowledge).filter(r => r.owner_id === a).length }]);
    if (sql.startsWith('INSERT INTO agent_data.knowledge_bases')) { state.knowledge.push({id:a,owner_id:b,source_root:c,wiki_root:d,visibility:'private'}); return result([]); }
    if (sql.startsWith('INSERT INTO agent_data.hub_skills')) { state.skills.push({ id: a, owner_id: b, name: c, files: d, version: e, scope: 'private' }); return result([]); }
    if (sql.startsWith('INSERT INTO agent_data.resource_grants')) {
      if (!state.grants.some(g => g.resource_type === a && g.resource_id === b && g.grantee_id === c)) state.grants.push({ resource_type: a, resource_id: b, grantee_id: c, granted_by: d });
      const row = (a === 'knowledge' ? state.knowledge : state.skills).find(r => r.id === b); row[a === 'knowledge' ? 'visibility' : 'scope'] = 'shared'; return result([]);
    }
    if (sql.startsWith('DELETE FROM agent_data.resource_grants')) {
      state.grants = state.grants.filter(g => !(g.resource_type === a && g.resource_id === b && (c === undefined || g.grantee_id === c)));
      const row = (a === 'knowledge' ? state.knowledge : state.skills).find(r => r.id === b), field = a === 'knowledge' ? 'visibility' : 'scope';
      if (row[field] !== 'system' && !state.grants.some(g => g.resource_type === a && g.resource_id === b)) row[field] = 'private'; return result([]);
    }
    if (sql.startsWith('INSERT INTO agent_data.skill_share_requests')) { state.requests = state.requests.filter(r => r.skill_id !== a); state.requests.push({ skill_id: a, proposed_by: b, grantees: c, status: 'pending' }); return result([]); }
    if (sql.startsWith('SELECT * FROM agent_data.skill_share_requests')) return result(state.requests.filter(r => r.skill_id === a));
    if (sql.startsWith('UPDATE agent_data.skill_share_requests SET grantees')) { const r = state.requests.find(r => r.skill_id === a && r.status === 'pending'); if (r) r.grantees = r.grantees.filter(x => x !== b); return result([]); }
    if (sql.startsWith('UPDATE agent_data.skill_share_requests SET status')) { Object.assign(state.requests.find(r => r.skill_id === a), { status: b, reviewed_by: c }); return result([]); }
    if (sql.startsWith('UPDATE agent_data.knowledge_bases')) { state.knowledge.find(r => r.id === a).visibility = b; return result([]); }
    if (sql.startsWith('UPDATE agent_data.users SET plan_id')) { state.users.find(u => u.id === a).plan_id = b; return result([]); }
    if (sql.startsWith('INSERT INTO agent_data.permission_events')) { state.events.push({ actor: a, action: b, type: c, id: d, before: JSON.parse(e), after: JSON.parse(f) }); return result([]); }
    throw new Error(`Unimplemented test query: ${sql}`);
  } };
  const agent = { id: 'writing-assistant', tools: { allow: ['read_file','kb_read','read_webpage'] }, knowledge: [{ kbId: 'general', actions: ['read','update','index'] }] };
  let now = Date.parse('2026-11-07T12:00:00Z');
  const hub = new Hub({ pool, instanceId: 'test', usage: { now: () => now, budget: { timezone: 'America/Los_Angeles' } }, catalog: () => [
    { type: 'agent', id: agent.id, planId: 'writing', scope: 'system' },
    { type: 'tool_group', id: 'files', scope: 'system', tools: ['read_file','shell'] },
    { type: 'tool_group', id: 'knowledge', scope: 'system', tools: ['kb_read'] },
    { type: 'tool_group', id: 'web', scope: 'system', tools: ['read_webpage'] },
  ] });
  return { hub, state, pool, agent, as: (owner, op) => runOwner(owner, () => hub.withUser(owner, op)), time: value => { now = value; } };
}
