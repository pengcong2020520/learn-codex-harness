import { currentIdentity } from '../accounts/context.mjs';
import { transaction } from '../data/database.mjs';
// A separate durable job type and Redis key, sharing the single process worker lifecycle.
export class KnowledgeWorker {
  constructor(service, redis) { this.controller = new AbortController(); this.service = service; this.redis = redis; this.key = `agent:${service.instanceId}:knowledge-ready`; }
  query(sql, args = [], client) {
    const s = this.service;
    if (!s.sharding) return s.systemQuery(sql, args, client);
    // Every worker statement names only a KB owned by its loop's user.
    sql = sql.replaceAll('$2::uuid IS NOT NULL', sql.includes('SELECT owner_id FROM agent_data.knowledge_bases') ? 'owner_id=$2' : 'kb_id IN (SELECT id FROM agent_data.knowledge_bases WHERE instance_id=$1 AND owner_id=$2)');
    return s.query(sql, args, client);
  }
  get queueKey() { return this.key + (this.service.sharding ? ':' + currentIdentity().userId : ''); }
  async recoverOwner() {
    const s = this.service;
    // Staging indexes are disposable. A crash never advances the effective pointer.
    const orphaned = (await this.query(`SELECT manifest FROM agent_data.knowledge_indexes WHERE instance_id=$1 AND state='building' AND $2::uuid IS NOT NULL`)).rows;
    for (const row of orphaned) await s.rag.discard(row.manifest).catch(() => {});
    await this.query(`UPDATE agent_data.knowledge_indexes SET state='failed',error='构建中断，请重新提交。' WHERE instance_id=$1 AND state='building' AND $2::uuid IS NOT NULL`);
    await this.query(`UPDATE agent_data.knowledge_jobs SET state='failed',error='构建中断，请重新提交。' WHERE instance_id=$1 AND state='running' AND $2::uuid IS NOT NULL`);
    
  }
  async open() {
    if (this.service.sharding) await this.service.sharding.eachOwner(() => this.recoverOwner(), { includePaused: true });
    else await this.recoverOwner();
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); this.tick(); return this;
  }
  async wake(id) { try { await this.redis.sAdd(this.queueKey, id); } catch { /* PG pending rows are the outbox; republished on the next tick. */ } }
  tick() {
    if (this.closed || this.running) return this.running;
    this.running = this.poll().catch(() => { this.degraded = true; }).finally(() => { this.running = null; });
    return this.running;
  }
  async poll() {
    if (this.service.sharding) return this.service.sharding.eachOwner(() => this.pollOwner());
    return this.pollOwner();
  }
  async pollOwner() {
    const s = this.service;
    const rows = (await this.query(`SELECT id FROM agent_data.knowledge_jobs WHERE instance_id=$1 AND state='queued' AND $2::uuid IS NOT NULL ORDER BY created_at LIMIT 20`)).rows;
    for (const row of rows) await this.redis.sAdd(this.queueKey, row.id);
    const id = await this.redis.sPop(this.queueKey);
    this.degraded = false;
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) return;
    if (s.gate.permissionHub) {
      const pending = (await this.query(`SELECT k.owner_id FROM agent_data.knowledge_jobs j JOIN agent_data.knowledge_bases k
        ON k.instance_id=j.instance_id AND k.id=j.kb_id WHERE j.instance_id=$1 AND j.id=$3 AND j.state='queued' AND $2::uuid IS NOT NULL`, [id])).rows[0];
      if (!pending || (await s.gate.permissionHub.plan(pending.owner_id)).exceeded) return;
    }
    const job = await transaction(s.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))', [s.instanceId]);
      return (await this.query(`UPDATE agent_data.knowledge_jobs SET state='running' WHERE instance_id=$1 AND id=$3 AND state='queued' AND $2::uuid IS NOT NULL RETURNING *`, [id], client)).rows[0];
    });
    if (!job) return;
    try {
      const owner = (await this.query('SELECT owner_id FROM agent_data.knowledge_bases WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL', [job.kb_id])).rows[0];
      if (!owner) throw new Error('知识库不存在。');
      const build = () => s.gate.run(s.gate.operator(owner.owner_id), () => s.rag.build(s, job.kb_id), this.controller.signal);
      const runtime = () => s.withOwner ? s.withOwner(owner.owner_id, build) : build();
      if (s.gate.permissionHub) await s.gate.permissionHub.withUser(owner.owner_id, runtime); else await runtime();
      await this.query(`UPDATE agent_data.knowledge_jobs SET state='completed' WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL`, [id]);
    } catch (error) {
      await this.query(`UPDATE agent_data.knowledge_jobs SET state='failed',error=$4 WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL`, [id, s.redact(error.message).slice(0, 1000)]);
    }
  }
  async close() { this.closed = true; this.controller.abort(); clearInterval(this.timer); await this.running; }
}
