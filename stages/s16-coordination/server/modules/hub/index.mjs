import { knowledgeBinding } from '../knowledge/directories.mjs';
import { validateKnowledgeBindings } from '../data/paths.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { transaction } from '../data/database.mjs';
import { currentIdentity } from '../accounts/context.mjs';
import { periodBounds } from '../usage/index.mjs';
import { AppError } from '../../../shared/errors.mjs';
import { ACTIONS, can, decision, effectiveTools, quota, owns } from './policy.mjs';
import { validateUpload, packagedSkill } from './skills.mjs';
export { can, decision, effectiveTools, quota, owns } from './policy.mjs';
const key = r => `${r.type}:${r.id}`;
const missing = () => { throw new AppError('资源不存在。', 404, 'HUB_DENIED'); };
export class Hub {
  constructor({ pool, instanceId, usage, catalog = () => [], systemSkills = () => [] }) {
    Object.assign(this, { pool, instanceId, usage, catalog, systemSkills });
    this.context = new AsyncLocalStorage();
  }
  query(sql, values = [], client = this.pool) { return client.query(sql, [this.instanceId, ...values]); }
  async user(id = currentIdentity()?.userId, client = this.pool, allowDisabled = false) {
    const row = (await this.query(`SELECT u.id,u.username,u.role,u.disabled_at,u.plan_id,row_to_json(p) AS plan
      FROM agent_data.users u JOIN agent_data.plans p ON p.id=u.plan_id WHERE u.instance_id=$1 AND u.id=$2`, [id], client)).rows[0];
    if (!row || (row.disabled_at && !allowDisabled)) missing();
    return row;
  }
  async snapshot(id = currentIdentity()?.userId, { allowDisabled = false } = {}) {
    return transaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const user = await this.user(id, client, allowDisabled);
      user.grants = (await this.query('SELECT resource_type,resource_id FROM agent_data.resource_grants WHERE instance_id=$1 AND grantee_id=$2', [id], client)).rows.map(r => `${r.resource_type}:${r.resource_id}`);
      const knowledge = (await this.query(`SELECT k.*,u.username AS owner FROM agent_data.knowledge_bases k JOIN agent_data.users u ON u.instance_id=k.instance_id AND u.id=k.owner_id WHERE k.instance_id=$1`, [], client)).rows.map(r => ({ ...r, type: 'knowledge', scope: r.visibility }));
      const skills = (await this.query(`SELECT s.*,u.username AS owner FROM agent_data.hub_skills s JOIN agent_data.users u ON u.instance_id=s.instance_id AND u.id=s.owner_id WHERE s.instance_id=$1`, [], client)).rows.map(r => ({ ...r, type: 'skill' }));
      return { user, resources: new Map([...this.catalog(), ...knowledge, ...skills].map(r => [key(r), r])) };
    });
  }
  current() { const value = this.context.getStore(); if (!value) throw new Error('Hub 缺少可信权限快照。'); return value; }
  run(snapshot, operation) { return this.context.run(snapshot, operation); }
  async withUser(id, operation) { return this.run(await this.snapshot(id), operation); }
  can(user, action, resource) { return can(user, action, resource); }
  resource(type, id) { return this.current().resources.get(`${type}:${id}`); }
  check(action, resource) { return can(this.current().user, action, resource); }
  checkResource(type, id, action = 'read') { const r = this.resource(type, id); this.check(action, r); return r; }
  checkAgent(agent) { return this.checkResource('agent', agent.definition.agent.id, 'use'); }
  checkTool(name, agent) {
    const groups = [...this.current().resources.values()].filter(r => r.type === 'tool_group');
    if (!effectiveTools(this.current().user, agent.definition.agent, groups).includes(name)) missing();
    return true;
  }
  checkFile(row, action = 'read') {
    if (!row) missing();
    const kb = [...this.current().resources.values()].find(r => r.type === 'knowledge' && r.owner_id === row.owner_id && (row.locator === r.source_root || row.locator.startsWith(r.source_root + '/')));
    return this.check(action, kb || { ...row, type: 'personal' });
  }
  visible(user = this.current().user) {
    return [...this.current().resources.values()].filter(r => decision(user, 'read', r) === 200)
      .map(r => ({ type: r.type, id: r.id, name: r.title || r.name || r.id, scope: r.scope, owner: r.owner ?? null,
        actions: ACTIONS.filter(action => decision(user, action, r) === 200) }));
  }
  async plan(id = currentIdentity()?.userId, active = 0) {
    const user = await this.user(id), now = this.usage?.now() ?? Date.now();
    const timezone = this.usage?.budget.timezone || 'UTC', bounds = periodBounds('today', now, timezone);
    await this.usage?.pending;
    const used = Number((await this.query(`SELECT coalesce(sum(total_tokens),0) AS n FROM agent_data.usage
      WHERE instance_id=$1 AND owner_id=$2 AND created_at >= $3 AND created_at < $4`, [id, new Date(bounds.start), new Date(bounds.end)])).rows[0].n);
    return { plan: user.plan, exempt: user.role === 'admin', timezone, ...quota(user, used, active, new Date(bounds.end).toISOString()) };
  }
  async nativeSearch(id) {
    const snapshot = await this.snapshot(id);
    const group = snapshot.resources.get('tool_group:web');
    return decision(snapshot.user, 'use', group) === 200 && group.tools.includes('read_webpage');
  }
  async allowedSkills(id) {
    const snapshot = await this.snapshot(id, { allowDisabled: true });
    if (snapshot.user.disabled_at) return [];
    return [...this.systemSkills(), ...[...snapshot.resources.values()].filter(r => r.type === 'skill' && r.files && !Array.isArray(r.files) && (owns(snapshot.user, r) || r.scope === 'system' || (r.scope === 'shared' && snapshot.user.grants.includes(key(r)))) && decision(snapshot.user, 'use', r) === 200).map(packagedSkill)];
  }
  async audit(client, actor, action, type, id, before, after, detail = null) {
    await this.query(`INSERT INTO agent_data.permission_events(instance_id,actor_id,action,resource_type,resource_id,before_state,after_state,detail)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.id, action, type, id, JSON.stringify(before), JSON.stringify(after), JSON.stringify(detail)], client);
  }
  async mutate(type, id, action, operation) {
    const actorId = currentIdentity()?.userId;
    return transaction(this.pool, async client => {
      // 所有 Hub 写操作按实例串行，防止分享/发布/降级间的 TOCTOU。
      await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))', [], client);
      const actor = await this.user(actorId, client);
      const table = type === 'knowledge' ? 'knowledge_bases' : 'hub_skills';
      const row = (await this.query(`SELECT * FROM agent_data.${table} WHERE instance_id=$1 AND id=$2 FOR UPDATE`, [id], client)).rows[0];
      const grants = (await this.query('SELECT grantee_id FROM agent_data.resource_grants WHERE instance_id=$1 AND resource_type=$2 AND resource_id=$3', [type, id], client)).rows.map(r => r.grantee_id);
      actor.grants = grants.includes(actor.id) ? [`${type}:${id}`] : [];
      can(actor, action, row && { ...row, type, scope: row.visibility ?? row.scope });
      return operation(client, actor, row, grants);
    });
  }
  async targets(client, owner, usernames, existing = []) {
    if (!Array.isArray(usernames) || !usernames.length || usernames.length > 20 || usernames.some(n => typeof n !== 'string') || new Set(usernames).size !== usernames.length) throw new AppError('授权名单需要 1–20 个不同用户名。', 400);
    const users = (await this.query('SELECT id,username,disabled_at FROM agent_data.users WHERE instance_id=$1 AND username=ANY($2::text[]) FOR SHARE', [usernames], client)).rows;
    if (users.length !== usernames.length || users.some(u => u.id === owner || u.id === currentIdentity()?.userId || u.disabled_at)) throw new AppError('不能授权给自己、不存在或已禁用账号。', 400);
    if (new Set([...existing, ...users.map(u => u.id)]).size > 20) throw new AppError('每个资源最多授权 20 人。', 409);
    return users;
  }
  async grants(type, id) {
    return this.mutate(type, id, 'share', async client => (await this.query(`SELECT u.username,g.created_at FROM agent_data.resource_grants g JOIN agent_data.users u ON u.instance_id=g.instance_id AND u.id=g.grantee_id WHERE g.instance_id=$1 AND g.resource_type=$2 AND g.resource_id=$3 ORDER BY u.username`, [type, id], client)).rows);
  }
  async grantKnowledge(id, username) {
    return this.mutate('knowledge', id, 'share', async (client, actor, row, before) => {
      if (row.visibility === 'system') throw new AppError('system 资源无需授权。', 409);
      const [target] = await this.targets(client, row.owner_id, [username], before);
      await this.insertGrant(client, actor, 'knowledge', id, target.id);
      const after = [...new Set([...before, target.id])];
      await this.audit(client, actor, 'share', 'knowledge', id, before, after); return { grantees: after, scope: 'shared' };
    });
  }
  insertGrant(client, actor, type, id, target) { return this.query(`INSERT INTO agent_data.resource_grants(instance_id,resource_type,resource_id,grantee_id,granted_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [type, id, target, actor.id], client); }
  async revoke(type, id, username) {
    const result = await this.mutate(type, id, 'share', async (client, actor, row, before) => {
      const target = (await this.query('SELECT id FROM agent_data.users WHERE instance_id=$1 AND username=$2', [username], client)).rows[0];
      if (!target) missing();
      await this.query('DELETE FROM agent_data.resource_grants WHERE instance_id=$1 AND resource_type=$2 AND resource_id=$3 AND grantee_id=$4', [type, id, target.id], client);
      // 撤销也从待审批名单移除，旧申请不能重新授予已撤销对象。
      if (type === 'skill') await this.query(`UPDATE agent_data.skill_share_requests SET grantees=array_remove(grantees,$3::uuid),updated_at=now() WHERE instance_id=$1 AND skill_id=$2 AND status='pending'`, [id, target.id], client);
      await this.audit(client, actor, 'unshare', type, id, before, before.filter(x => x !== target.id));
      return { owner: target.id, revoked: true };
    });
    if (type === 'skill') await this.syncSkills?.([result.owner]);
    return { revoked: true };
  }
  async publish(id, enabled = true) {
    return this.mutate('knowledge', id, 'share', async (client, actor, row, grants) => {
      if (actor.role !== 'admin') throw new AppError('只有 admin 可以发布。', 403);
      // 取消发布回到 private；不会复活发布前的旧授权。
      await this.query('DELETE FROM agent_data.resource_grants WHERE instance_id=$1 AND resource_type=$2 AND resource_id=$3', ['knowledge', id], client);
      const scope = enabled ? 'system' : 'private';
      await this.query('UPDATE agent_data.knowledge_bases SET visibility=$3 WHERE instance_id=$1 AND id=$2', [id, scope], client);
      await this.audit(client, actor, 'publish', 'knowledge', id, row.visibility, scope, { revokedGrantees: grants }); return { scope };
    });
  }
  async registerKnowledge(owner, id, binding) {
    return transaction(this.pool, async client => {
      await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))', [], client);
      const actor = await this.user(owner, client);
      const old = (await this.query('SELECT * FROM agent_data.knowledge_bases WHERE instance_id=$1 AND id=$2', [id], client)).rows[0];
      if (old) {
        can(actor, 'modify', { ...old, type: 'knowledge' });
        if (old.source_root !== binding.sourceRoot || old.wiki_root !== binding.wikiRoot) throw new AppError('知识库绑定路径冲突。', 409);
        return false;
      }
      // A configured default must not silently resurrect a library explicitly deleted via HTTP.
      if ((await this.query("SELECT 1 FROM agent_data.permission_events WHERE instance_id=$1 AND resource_type='knowledge' AND resource_id=$2 AND action='knowledge:delete' LIMIT 1", [id], client)).rows.length) return false;
      const count = Number((await this.query('SELECT count(*) AS n FROM agent_data.knowledge_bases WHERE instance_id=$1 AND owner_id=$2', [owner], client)).rows[0].n);
      if (actor.role !== 'admin' && count >= actor.plan.max_knowledge_bases) throw new AppError('知识库数量达到权益上限。', 403, 'PLAN_LIMIT');
      await this.query('INSERT INTO agent_data.knowledge_bases(instance_id,id,owner_id,source_root,wiki_root) VALUES($1,$2,$3,$4,$5)', [id, owner, binding.sourceRoot, binding.wikiRoot], client);
      return true;
    });
  }
  async createKnowledge({ kbId, title, ...unknown }, prepare) {
    if (Object.keys(unknown).length || typeof kbId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(kbId) ||
        typeof title !== 'string' || !title.trim() || title.length > 200)
      throw new AppError('需要有效的 kbId（1–64 位小写字母、数字、连字符）和 1–200 字标题。', 400);
    const binding = knowledgeBinding(kbId);
    return transaction(this.pool, async client => {
      await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))', [], client);
      const actor = await this.user(currentIdentity().userId, client);
      const old = (await this.query('SELECT * FROM agent_data.knowledge_bases WHERE instance_id=$1 AND id=$2', [kbId], client)).rows[0];
      if (old) throw new AppError('知识库 ID 已存在。', 409);
      const count = Number((await this.query('SELECT count(*) AS n FROM agent_data.knowledge_bases WHERE instance_id=$1 AND owner_id=$2', [actor.id], client)).rows[0].n);
      if (actor.role !== 'admin' && count >= actor.plan.max_knowledge_bases) throw new AppError('知识库数量达到权益上限。', 403, 'PLAN_LIMIT');
      const existing = (await this.query('SELECT id,source_root,wiki_root FROM agent_data.knowledge_bases WHERE instance_id=$1', [], client)).rows;
      try { validateKnowledgeBindings({ ...Object.fromEntries(existing.map(r => [r.id, { sourceRoot: r.source_root, wikiRoot: r.wiki_root }])), [kbId]: binding }); }
      catch { throw new AppError('知识库路径与已有绑定重叠。', 409); }
      await this.query(`INSERT INTO agent_data.knowledge_bases(instance_id,id,owner_id,source_root,wiki_root,title,user_created,visibility)
        VALUES($1,$2,$3,$4,$5,$6,true,'private')`, [kbId, actor.id, binding.sourceRoot, binding.wikiRoot, title.trim()], client);
      await this.audit(client, actor, 'knowledge:create', 'knowledge', kbId, null, { ownerId: actor.id, title: title.trim(), visibility: 'private', ...binding });
      // The lock covers count, registry insertion and filesystem preparation. A failed prepare rolls back SQL.
      await prepare(actor.id, binding, client);
      return { kbId, title: title.trim(), ownerId: actor.id, visibility: 'private', ...binding };
    });
  }
  async deleteKnowledge(id, cleanup) {
    return this.mutate('knowledge', id, 'delete', async (client, actor, row, grants) => {
      // Keep resource writes out while revoking their source records. Task startup is also
      // serialized by the service ExecutionBoundary; the indexing worker uses Hub's lock.
      await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,1))', [], client);
      const active = (await this.query(`SELECT 1 FROM agent_data.tasks t JOIN agent_data.conversations c
        ON c.instance_id=t.instance_id AND c.id=t.thread_id WHERE t.instance_id=$1
        AND t.status IN ('starting','running','steering') AND $2=ANY(c.hub_knowledge) LIMIT 1`, [id], client)).rows.length;
      const indexing = (await this.query("SELECT 1 FROM agent_data.knowledge_jobs WHERE instance_id=$1 AND kb_id=$2 AND state='running' LIMIT 1", [id], client)).rows.length;
      if (active || indexing) throw new AppError('知识库仍被执行中任务挂载。', 409, 'KNOWLEDGE_BUSY');
      const indexes = (await this.query('SELECT manifest FROM agent_data.knowledge_indexes WHERE instance_id=$1 AND kb_id=$2', [id], client)).rows;
      await cleanup(row, indexes, client);
      await this.query('DELETE FROM agent_data.resource_grants WHERE instance_id=$1 AND resource_type=$2 AND resource_id=$3', ['knowledge', id], client);
      await this.query(`UPDATE agent_data.resources SET state='revoked',updated_at=now() WHERE instance_id=$1 AND owner_id=$2
        AND (locator=$3 OR starts_with(locator,$3 || '/') OR locator=$4 OR starts_with(locator,$4 || '/'))`, [row.owner_id, row.source_root, row.wiki_root], client);
      await this.query('UPDATE agent_data.knowledge_bases SET index_revision=NULL WHERE instance_id=$1 AND id=$2', [id], client);
      await this.query('UPDATE agent_data.wiki_pages SET current_version=NULL WHERE instance_id=$1 AND kb_id=$2', [id], client);
      for (const table of ['wiki_versions', 'wiki_pages', 'knowledge_mounts', 'knowledge_jobs', 'knowledge_indexes'])
        await this.query(`DELETE FROM agent_data.${table} WHERE instance_id=$1 AND kb_id=$2`, [id], client);
      await this.query('DELETE FROM agent_data.knowledge_bases WHERE instance_id=$1 AND id=$2', [id], client);
      await this.audit(client, actor, 'knowledge:delete', 'knowledge', id, { ...row, grantees: grants }, null);
      return { kbId: id, deleted: true };
    });
  }
  async upload(body) {
    const skill = validateUpload(body), id = `u-${randomUUID()}`;
    const owner = currentIdentity().userId;
    await transaction(this.pool, async client => {
      await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))', [], client);
      const actor = await this.user(owner, client);
      const count = Number((await this.query('SELECT count(*) AS n FROM agent_data.hub_skills WHERE instance_id=$1 AND owner_id=$2', [owner], client)).rows[0].n);
      if (actor.role !== 'admin' && count >= actor.plan.max_private_skills) throw new AppError('私有 Skill 数量达到权益上限。', 403);
      await this.query('INSERT INTO agent_data.hub_skills(instance_id,id,owner_id,name,files,version) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, skill.name, skill.files, skill.version], client);
      await this.audit(client, actor, 'upload', 'skill', id, null, { name: skill.name, scope: 'private', version: skill.version });
    });
    await this.syncSkills?.([owner]); return { id, scope: 'private' };
  }
  async readSkill(id) {
    const skill = this.checkResource('skill', id, 'read');
    if (!skill.files || Array.isArray(skill.files)) throw new AppError('系统 Skill 由部署代码提供。', 409);
    const user = this.current().user;
    const request = user.role === 'admin' || owns(user, skill)
      ? (await this.query('SELECT * FROM agent_data.skill_share_requests WHERE instance_id=$1 AND skill_id=$2', [id])).rows[0] : undefined;
    return { id, name: skill.name, scope: skill.scope, owner: skill.owner, version: skill.version, files: skill.files, request };
  }
  async shareSkill(id, usernames) {
    return this.mutate('skill', id, 'share', async (client, actor, row, before) => {
      if (!owns(actor, row)) throw new AppError('共享申请由所有者提出。', 403);
      const targets = await this.targets(client, row.owner_id, usernames, before);
      await this.query(`INSERT INTO agent_data.skill_share_requests(instance_id,skill_id,proposed_by,grantees,status) VALUES($1,$2,$3,$4,'pending')
        ON CONFLICT(instance_id,skill_id) DO UPDATE SET proposed_by=EXCLUDED.proposed_by,grantees=EXCLUDED.grantees,status='pending',reviewed_by=NULL,updated_at=now()`, [id, actor.id, targets.map(u => u.id)], client);
      await this.audit(client, actor, 'share', 'skill', id, before, { status: 'pending', usernames }); return { status: 'pending' };
    });
  }
  async reviewSkill(id, approve) {
    const result = await this.mutate('skill', id, 'share', async (client, actor, row, before) => {
      const request = (await this.query('SELECT * FROM agent_data.skill_share_requests WHERE instance_id=$1 AND skill_id=$2 FOR UPDATE', [id], client)).rows[0];
      if (actor.role !== 'admin' || request?.proposed_by === actor.id) throw new AppError('需要另一位 admin 审批，不能自批。', 403);
      if (request?.status !== 'pending') throw new AppError('没有待审批申请。', 409);
      if (approve) {
        const users = (await this.query('SELECT username FROM agent_data.users WHERE instance_id=$1 AND id=ANY($2::uuid[])', [request.grantees], client)).rows;
        const targets = await this.targets(client, row.owner_id, users.map(u => u.username), before);
        for (const target of targets) await this.insertGrant(client, actor, 'skill', id, target.id);
      }
      const status = approve ? 'approved' : 'rejected';
      await this.query('UPDATE agent_data.skill_share_requests SET status=$3,reviewed_by=$4,updated_at=now() WHERE instance_id=$1 AND skill_id=$2', [id, status, actor.id], client);
      await this.audit(client, actor, approve ? 'skill:approve' : 'skill:reject', 'skill', id, request, { status, grantees: request.grantees });
      return { status, owners: request.grantees };
    });
    if (approve) await this.syncSkills?.(result.owners);
    return { status: result.status };
  }
  async assign(username, planId) {
    return transaction(this.pool, async client => {
      await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))', [], client);
      const actor = await this.user(currentIdentity().userId, client);
      if (actor.role !== 'admin') throw new AppError('只有 admin 可以分配权益。', 403);
      const plan = (await client.query('SELECT id FROM agent_data.plans WHERE id=$1', [planId])).rows[0];
      const target = (await this.query('SELECT id,plan_id FROM agent_data.users WHERE instance_id=$1 AND username=$2 FOR UPDATE', [username], client)).rows[0];
      if (!plan || !target) throw new AppError('用户或权益不存在。', 404);
      await this.query('UPDATE agent_data.users SET plan_id=$3 WHERE instance_id=$1 AND id=$2', [target.id, planId], client);
      await this.audit(client, actor, 'plan:assign', 'user', target.id, target.plan_id, planId); return { username, plan: planId };
    });
  }
}
