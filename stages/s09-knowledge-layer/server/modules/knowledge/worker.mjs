// A separate durable job type and Redis key, sharing the single process worker lifecycle.
export class KnowledgeWorker {
  constructor(service, redis) { this.controller = new AbortController(); this.service = service; this.redis = redis; this.key = `agent:${service.instanceId}:knowledge-ready`; }
  async open() {
    const s = this.service;
    // Staging indexes are disposable. A crash never advances the effective pointer.
    const orphaned = (await s.query(`SELECT manifest FROM agent_data.knowledge_indexes WHERE instance_id=$1 AND state='building' AND $2::uuid IS NOT NULL`)).rows;
    for (const row of orphaned) await s.rag.discard(row.manifest).catch(() => {});
    await s.query(`UPDATE agent_data.knowledge_indexes SET state='failed',error='构建中断，请重新提交。' WHERE instance_id=$1 AND state='building' AND $2::uuid IS NOT NULL`);
    await s.query(`UPDATE agent_data.knowledge_jobs SET state='failed',error='构建中断，请重新提交。' WHERE instance_id=$1 AND state='running' AND $2::uuid IS NOT NULL`);
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
    const rows = (await s.query(`SELECT id FROM agent_data.knowledge_jobs WHERE instance_id=$1 AND state='queued' AND $2::uuid IS NOT NULL ORDER BY created_at LIMIT 20`)).rows;
    for (const row of rows) await this.redis.sAdd(this.key, row.id);
    const id = await this.redis.sPop(this.key);
    this.degraded = false;
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) return;
    const job = (await s.query(`UPDATE agent_data.knowledge_jobs SET state='running' WHERE instance_id=$1 AND id=$3 AND state='queued' AND $2::uuid IS NOT NULL RETURNING *`, [id])).rows[0];
    if (!job) return;
    try {
      await s.gate.run(s.gate.operator(), () => s.rag.build(s, job.kb_id), this.controller.signal);
      await s.query(`UPDATE agent_data.knowledge_jobs SET state='completed' WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL`, [id]);
    } catch (error) {
      await s.query(`UPDATE agent_data.knowledge_jobs SET state='failed',error=$4 WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL`, [id, s.redact(error.message).slice(0, 1000)]);
    }
  }
  async close() { this.closed = true; this.controller.abort(); clearInterval(this.timer); await this.running; }
}
