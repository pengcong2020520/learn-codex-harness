import { transaction } from '../data/database.mjs';
// A separate durable job type and Redis key, sharing the single process worker lifecycle.
export class KnowledgeWorker {
  constructor(service, redis) { this.controller = new AbortController(); this.service = service; this.redis = redis; this.key = `agent:${service.instanceId}:knowledge-ready`; }
  async open() {
    const s = this.service;
    // Staging indexes are disposable. A crash never advances the effective pointer.
    const orphaned = (await s.systemQuery(`SELECT manifest FROM agent_data.knowledge_indexes WHERE instance_id=$1 AND state='building' AND $2::uuid IS NOT NULL`)).rows;
    for (const row of orphaned) await s.rag.discard(row.manifest).catch(() => {});
    await s.systemQuery(`UPDATE agent_data.knowledge_indexes SET state='failed',error='构建中断，请重新提交。' WHERE instance_id=$1 AND state='building' AND $2::uuid IS NOT NULL`);
    await s.systemQuery(`UPDATE agent_data.knowledge_jobs SET state='failed',error='构建中断，请重新提交。' WHERE instance_id=$1 AND state='running' AND $2::uuid IS NOT NULL`);
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); this.tick(); return this;
  }
  async wake(id) { try { await this.redis.sAdd(this.key, id); } catch { /* PG pending rows are the outbox; republished on the next tick. */ } }
  tick() {
    if (this.closed || this.running) return this.running;
    this.running = this.poll().catch(() => { this.degraded = true; }).finally(() => { this.running = null; });
    return this.running;
  }
  async poll() {
    const s = this.service;
    const rows = (await s.systemQuery(`SELECT id FROM agent_data.knowledge_jobs WHERE instance_id=$1 AND state='queued' AND $2::uuid IS NOT NULL ORDER BY created_at LIMIT 20`)).rows;
    for (const row of rows) await this.redis.sAdd(this.key, row.id);
    const id = await this.redis.sPop(this.key);
    this.degraded = false;
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) return;
    if (s.gate.permissionHub) {
      const pending = (await s.systemQuery(`SELECT k.owner_id FROM agent_data.knowledge_jobs j JOIN agent_data.knowledge_bases k
        ON k.instance_id=j.instance_id AND k.id=j.kb_id WHERE j.instance_id=$1 AND j.id=$3 AND j.state='queued' AND $2::uuid IS NOT NULL`, [id])).rows[0];
      if (!pending || (await s.gate.permissionHub.plan(pending.owner_id)).exceeded) return;
    }
    const job = await transaction(s.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))', [s.instanceId]);
      return (await s.systemQuery(`UPDATE agent_data.knowledge_jobs SET state='running' WHERE instance_id=$1 AND id=$3 AND state='queued' AND $2::uuid IS NOT NULL RETURNING *`, [id], client)).rows[0];
    });
    if (!job) return;
    try {
      const owner = (await s.systemQuery('SELECT owner_id FROM agent_data.knowledge_bases WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL', [job.kb_id])).rows[0];
      if (!owner) throw new Error('知识库不存在。');
      const build = () => s.gate.run(s.gate.operator(owner.owner_id), () => s.rag.build(s, job.kb_id), this.controller.signal);
      const runtime = () => s.withOwner ? s.withOwner(owner.owner_id, build) : build();
      if (s.gate.permissionHub) await s.gate.permissionHub.withUser(owner.owner_id, runtime); else await runtime();
      await s.systemQuery(`UPDATE agent_data.knowledge_jobs SET state='completed' WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL`, [id]);
    } catch (error) {
      await s.systemQuery(`UPDATE agent_data.knowledge_jobs SET state='failed',error=$4 WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL`, [id, s.redact(error.message).slice(0, 1000)]);
    }
  }
  async close() { this.closed = true; this.controller.abort(); clearInterval(this.timer); await this.running; }
}
