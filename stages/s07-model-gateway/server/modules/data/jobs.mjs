import { Repository } from "./repository.mjs";
import { transaction } from "./database.mjs";
import { AppError } from "../../../shared/errors.mjs";

const columns = `$2::uuid AS "userId",t.workflow,t.params,t.checks,t.step,t.note,t.reason,t.id,t.thread_id AS "threadId",t.text,t.mode,t.target_turn_id AS "targetTurnId",
  t.turn_id AS "turnId",t.agent_hash AS "agentHash",t.status,t.error,t.created_at::float8 AS "createdAt"`;
const owned = `t.instance_id=$1 AND EXISTS(SELECT 1 FROM agent_data.conversations c
  WHERE c.instance_id=t.instance_id AND c.id=t.thread_id AND c.owner_id=$2)`;
export const executing = ["starting", "running", "steering"];
// needs-review：轮次正常完成但 workflow 验收没通过；cancelled：用户结束了等待确认或排队中的任务。
export const terminal = ["completed", "failed", "interrupted", "needs-review", "cancelled"];

export class PostgresJobs extends Repository {
  async get(id) {
    return (
      await this.query(
        `SELECT ${columns} FROM agent_data.tasks t WHERE ${owned} AND t.id=$3`,
        [id],
      )
    ).rows[0];
  }
  async list(threadId, { history = true } = {}) {
    return (
      await this.query(
        `SELECT ${columns} FROM agent_data.tasks t WHERE ${owned}
      AND ($3::text IS NULL OR t.thread_id=$3)
      AND (t.status<>ALL($4::text[]) OR ($5 AND t.sequence IN(
        SELECT last.sequence FROM agent_data.tasks last WHERE last.instance_id=$1 AND last.thread_id=t.thread_id
        AND last.status=ANY($4::text[]) ORDER BY last.sequence DESC LIMIT 20))) ORDER BY sequence`,
        [threadId || null, terminal, history],
      )
    ).rows;
  }
  async paused(threadId) {
    return (await this.conversation(threadId)).paused;
  }
  async wake(threadId, client = this.pool) {
    await this.query(
      `INSERT INTO agent_data.outbox(instance_id,thread_id)
      SELECT $1,id FROM agent_data.conversations WHERE instance_id=$1 AND owner_id=$2 AND id=$3
      ON CONFLICT(instance_id,thread_id) DO UPDATE SET generation=outbox.generation+1,due_at=now()`,
      [threadId],
      client,
    );
  }
  async create(job) {
    if (job.userId && job.userId !== this.ownerId) throw new AppError("任务用户不属于已认证范围。", 403);
    return transaction(this.pool, async (client) => {
      // Serializes count and per-thread changes even across accidental concurrent callers.
      const found = await this.query(
        "SELECT id FROM agent_data.conversations WHERE instance_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE",
        [job.threadId],
        client,
      );
      if (!found.rowCount) throw new AppError("会话不存在。", 404);
      const count = await this.query(
        `SELECT count(*)::int AS n FROM agent_data.tasks t WHERE ${owned} AND t.thread_id=$3 AND t.status='queued'`,
        [job.threadId],
        client,
      );
      if (count.rows[0].n >= 100)
        throw new AppError("本会话最多保留 100 条待执行消息。", 429);
      await this.query(
        `INSERT INTO agent_data.tasks(instance_id,id,thread_id,text,mode,target_turn_id,turn_id,agent_hash,status,created_at,error,workflow,params,reason)
        SELECT $1,$3,$4,$5,$6,$7,NULL,$8,$12,$9,NULL,$10,$11,$13 WHERE $2::uuid IS NOT NULL`,
        [
          job.id,
          job.threadId,
          job.text,
          job.mode,
          job.targetTurnId,
          job.agentHash || null,
          job.createdAt,
          job.workflow || "chat",
          job.params ? JSON.stringify(job.params) : null,
          job.status === "proposed" ? "proposed" : "queued",
          job.reason || null,
        ],
        client,
      );
      // 提议的任务等用户确认，不唤醒调度。
      if (job.status !== "proposed") await this.wake(job.threadId, client);
      await this.query(
        `UPDATE agent_data.conversations SET name=CASE WHEN name='' THEN $4 ELSE name END,updated_at=now()
        WHERE instance_id=$1 AND owner_id=$2 AND id=$3`,
        [job.threadId, job.text.slice(0, 100)],
        client,
      );
    });
  }
  async patch(id, fields, expected) {
    const mapping = { status: "status", turnId: "turn_id", error: "error", checks: "checks", step: "step", note: "note" };
    // checks 是数组：显式序列化，避免驱动把它当成 PostgreSQL 数组。
    const entries = Object.entries(fields).filter(([key]) => mapping[key])
      .map(([key, value]) => [key, key === "checks" && value != null ? JSON.stringify(value) : value]);
    if (!entries.length) return true;
    return transaction(this.pool, async (client) => {
      const values = [
        id,
        ...entries.map(([, value]) => value),
        expected || null,
      ];
      const result = await this.query(
        `UPDATE agent_data.tasks t SET ${entries.map(([key], i) => `${mapping[key]}=$${i + 4}`).join(",")}
        WHERE ${owned} AND t.id=$3 AND ($${values.length + 2}::text[] IS NULL OR t.status=ANY($${values.length + 2})) RETURNING t.thread_id,t.status`,
        values,
        client,
      );
      if (!result.rowCount) return false;
      const row = result.rows[0];
      if (fields.status === "queued") await this.wake(row.thread_id, client);
      if (terminal.includes(fields.status))
        await this.query(
          `INSERT INTO agent_data.notifications(instance_id,thread_id,task_id,status)
        SELECT $1,$3,$4,$5 WHERE $2::uuid IS NOT NULL`,
          [row.thread_id, id, row.status],
          client,
        );
      return true;
    });
  }
  async pause(threadId, value = true) {
    await transaction(this.pool, async (client) => {
      await this.query(
        "UPDATE agent_data.conversations SET paused=$4 WHERE instance_id=$1 AND owner_id=$2 AND id=$3",
        [threadId, value],
        client,
      );
      if (!value) await this.wake(threadId, client);
    });
  }
  async recover(reason) {
    await transaction(this.pool, async (client) => {
      await this.query(
        `UPDATE agent_data.tasks t SET status='unconfirmed',error=$3 WHERE ${owned} AND status=ANY($4::text[])`,
        [reason, executing],
        client,
      );
      await this.query(
        `UPDATE agent_data.conversations c SET paused=true WHERE instance_id=$1 AND owner_id=$2
        AND EXISTS(SELECT 1 FROM agent_data.tasks t WHERE t.instance_id=c.instance_id AND t.thread_id=c.id AND status='unconfirmed')`,
        [],
        client,
      );
      // Queued is definitely not dispatched; recover only these via the durable outbox.
      const threads = (
        await this.query(
          `SELECT DISTINCT t.thread_id FROM agent_data.tasks t WHERE ${owned} AND status='queued'`,
          [],
          client,
        )
      ).rows;
      for (const row of threads) await this.wake(row.thread_id, client);
    });
  }
  async deliveries() {
    return (
      await this.query(`SELECT o.thread_id,o.generation FROM agent_data.outbox o
      JOIN agent_data.conversations c ON c.instance_id=o.instance_id AND c.id=o.thread_id
      WHERE o.instance_id=$1 AND c.owner_id=$2 AND NOT c.paused AND o.due_at<=now()
      AND EXISTS(SELECT 1 FROM agent_data.tasks t WHERE t.instance_id=o.instance_id AND t.thread_id=o.thread_id AND t.status='queued')
      ORDER BY o.due_at LIMIT 100`)
    ).rows;
  }
  async delivered(row) {
    await this.query(
      `UPDATE agent_data.outbox SET due_at=now()+interval '5 seconds' WHERE instance_id=$1
      AND thread_id=$3 AND generation=$4 AND $2::uuid IS NOT NULL`,
      [row.thread_id, row.generation],
    );
  }
}
