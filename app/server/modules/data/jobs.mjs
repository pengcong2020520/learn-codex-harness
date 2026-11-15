import { can } from '../hub/policy.mjs';
import { runOwner } from '../accounts/context.mjs';
import { Repository } from "./repository.mjs";
import { transaction } from "./database.mjs";
import { AppError } from "../../../shared/errors.mjs";

const columns = `(SELECT c.owner_id FROM agent_data.conversations c WHERE c.instance_id=t.instance_id AND c.id=t.thread_id) AS "userId",t.single_workflow AS "single",t.feedback,t.attachments,t.model,t.selected_model AS "selectedModel",t.model_source AS "modelSource",t.workflow,t.params,t.checks,t.step,t.note,t.revise_count AS "reviseCount",t.reason,t.id,t.thread_id AS "threadId",t.text,t.mode,t.target_turn_id AS "targetTurnId",
  t.turn_id AS "turnId",t.agent_hash AS "agentHash",t.status,t.error,t.created_at::float8 AS "createdAt"`;
const owned = `t.instance_id=$1 AND EXISTS(SELECT 1 FROM agent_data.conversations c
  WHERE c.instance_id=t.instance_id AND c.id=t.thread_id AND c.owner_id=$2)`;
export const executing = ["starting", "running", "steering"];
export const cancellable = single => ["queued", "waiting", "proposed", ...(single ? ["failed", "needs-review", "unconfirmed"] : [])];
// needs-review：轮次正常完成但 workflow 验收没通过；cancelled：用户明确结束任务。
export const terminal = ["completed", "failed", "interrupted", "needs-review", "cancelled", "replica_missing"];

export class PostgresJobs extends Repository {
  async queueCapacity(client, threadId) {
    // All enqueue transitions use one transaction lock per deployment instance.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 12))", [this.instanceId]);
    const result = await this.query(`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE t.thread_id=$3)::int AS local
      FROM agent_data.tasks t WHERE t.instance_id=$1 AND $2::uuid IS NOT NULL AND t.status='queued'`, [threadId], client);
    if (result.rows[0].n >= (this.maxQueued ?? 200)) throw new AppError("全局排队已满。", 429, "QUEUE_FULL");
    if (result.rows[0].local >= 100) throw new AppError("本会话最多保留 100 条待执行消息。", 429, "QUEUE_FULL");
  }
  async allPending() {
    const rows = (await this.systemQuery(`SELECT ${columns} FROM agent_data.tasks t WHERE t.instance_id=$1 AND $2::uuid IS NOT NULL AND t.status<>ALL($3::text[]) ORDER BY sequence`, [terminal])).rows;
    return this.sharding ? this.sharding.filter(rows, 'userId') : rows;
  }
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
  async missing(threadId) {
    return (await this.query(`SELECT t.id,t.error FROM agent_data.tasks t WHERE ${owned}
      AND t.thread_id=$3 AND t.status='replica_missing' ORDER BY t.sequence`,[threadId])).rows;
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
  async workflowTasks(workflows) {
    return (await this.query(`SELECT t.id,t.workflow FROM agent_data.tasks t WHERE ${owned}
      AND t.workflow=ANY($3::text[]) AND t.mode<>'append' AND t.status NOT IN ('completed','cancelled')`, [workflows])).rows;
  }
  async workflowOccupancy(workflow, client = this.pool) {
    // 跨属主只读取占用摘要；任务内容和他人的任务 ID 不离开仓储。
    return (await this.query(`SELECT CASE WHEN c.owner_id=$2 THEN t.id END AS "taskId",
      u.username,t.created_at::float8 AS "startedAt"
      FROM agent_data.tasks t JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id
      JOIN agent_data.users u ON u.instance_id=c.instance_id AND u.id=c.owner_id
      WHERE t.instance_id=$1 AND t.workflow=$3 AND t.single_workflow AND t.status NOT IN ('completed','cancelled')`, [workflow], client)).rows[0] || null;
  }
  async singleConflict(workflow) {
    const occupied = await this.workflowOccupancy(workflow);
    const error = new AppError("这个工作流已有进行中的任务，请等当前任务完成或结束后再提交。", 409, "WORKFLOW_OCCUPIED");
    if (occupied) error.occupant = { username: occupied.username, startedAt: occupied.startedAt };
    return error;
  }
  async takeoverOwner(threadId, taskId, workflows) {
    const row = (await this.query(`SELECT c.owner_id FROM agent_data.tasks t
      JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id
      JOIN agent_data.users u ON u.instance_id=c.instance_id AND u.id=c.owner_id
      WHERE t.instance_id=$1 AND t.thread_id=$3 AND t.id=$4 AND t.single_workflow
      AND t.workflow=ANY($5::text[]) AND u.role='admin'
      AND EXISTS(SELECT 1 FROM agent_data.users a WHERE a.instance_id=$1 AND a.id=$2 AND a.role='admin' AND a.disabled_at IS NULL)`,
      [threadId, taskId, workflows])).rows[0];
    return row?.owner_id;
  }
  async takeoverWorkflowOwner(workflow, workflows) {
    const row = (await this.query(`SELECT c.owner_id FROM agent_data.tasks t
      JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id
      JOIN agent_data.users u ON u.instance_id=c.instance_id AND u.id=c.owner_id
      WHERE t.instance_id=$1 AND c.owner_id<>$2 AND t.workflow=$3 AND t.workflow=ANY($4::text[])
      AND t.single_workflow AND t.status NOT IN ('completed','cancelled') AND u.role='admin'
      AND EXISTS(SELECT 1 FROM agent_data.users a WHERE a.instance_id=$1 AND a.id=$2 AND a.role='admin' AND a.disabled_at IS NULL)`,
      [workflow, workflows])).rows[0];
    return row?.owner_id;
  }
  async cancelTakeoverWorkflow(workflow, startedAt, workflows) {
    return this.cancelTakeover(null, null, workflows, { workflow, startedAt });
  }
  async cancelTakeover(threadId, taskId, workflows, byWorkflow) {
    return transaction(this.pool, async client => {
      const actor = (await this.query(`SELECT username FROM agent_data.users
        WHERE instance_id=$1 AND id=$2 AND role='admin' AND disabled_at IS NULL FOR SHARE`, [], client)).rows[0];
      if (!actor) throw new AppError("只有管理员可以接管结束任务。", 403);
      // 跨属主只取接管必需的标识；锁内核对状态，与派发和其他管理员的接管互斥。
      const selector = byWorkflow ? "t.workflow=$3 AND t.status NOT IN ('completed','cancelled') AND $4::text IS NULL" : 't.thread_id=$3 AND t.id=$4';
      const job = (await this.query(`SELECT t.id,t.thread_id AS "threadId",c.owner_id AS "userId",t.status,t.created_at::float8 AS "createdAt"
        FROM agent_data.tasks t JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id
        JOIN agent_data.users u ON u.instance_id=c.instance_id AND u.id=c.owner_id
        WHERE t.instance_id=$1 AND c.owner_id<>$2 AND ${selector}
        AND t.single_workflow AND t.workflow=ANY($5::text[]) AND u.role='admin' FOR UPDATE OF t`,
        [byWorkflow?.workflow ?? threadId, taskId, workflows], client)).rows[0];
      if (!job) throw new AppError(byWorkflow ? "任务不存在或不允许接管结束" : "任务不存在或不允许接管结束。", 404);
      if (byWorkflow && job.createdAt !== byWorkflow.startedAt) throw new AppError("占用已变化，请刷新后核对", 409);
      return this.finishTakeover(client, actor, job);
    });
  }
  async finishTakeover(client, actor, job) {
    const { id: taskId, threadId } = job;
    if (executing.includes(job.status)) throw new AppError("任务正在运行，请等这一步完成或失败后再操作。", 409);
    if (!cancellable(true).includes(job.status)) throw new AppError("当前状态不能接管结束，请刷新后核对任务记录。", 409);
    await this.query(`UPDATE agent_data.tasks SET status='cancelled',error=$5
      WHERE instance_id=$1 AND $2::uuid IS NOT NULL AND id=$3 AND thread_id=$4`,
      [taskId, threadId, `已被管理员 ${actor.username} 结束`], client);
    // 复用只追加的审计表；before_state 只存属主，也使审计行沿用任务属主的分片门禁。
    await this.query(`INSERT INTO agent_data.permission_events(instance_id,actor_id,action,resource_type,resource_id,before_state)
      VALUES($1,$2,'task:cancel-takeover','task',$3,jsonb_build_object('owner_id',$4::text))`, [taskId, job.userId], client);
    await this.query(`INSERT INTO agent_data.notifications(instance_id,thread_id,task_id,status)
      SELECT $1,$3,$4,'cancelled' WHERE $2::uuid IS NOT NULL`, [threadId, taskId], client);
    return { id: taskId, threadId, userId: job.userId, status: 'cancelled' };
  }
  async feedback(id, note, attachments) {
    return transaction(this.pool, async client => {
      // 与派发领取和确认竞争同一行锁；先取队列锁，避免与入队事务锁顺序相反。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 12))", [this.instanceId]);
      const job = (await this.query(`SELECT ${columns} FROM agent_data.tasks t WHERE ${owned} AND t.id=$3 FOR UPDATE OF t`, [id], client)).rows[0];
      if (!job) throw new AppError("任务不存在。", 404);
      if (!['waiting', 'queued'].includes(job.status)) throw new AppError("任务状态已变化，请刷新后核对意见是否需要重新提交。", 409);
      if (job.status === 'waiting' && job.reviseCount >= 10) throw new AppError("本步已重做 10 次，请确认继续或结束任务", 409);
      if (job.status === 'waiting') await this.queueCapacity(client, job.threadId);
      await this.query(`UPDATE agent_data.tasks t SET status='queued',
        note=CASE WHEN status='waiting' THEN $4 ELSE note END,
        revise_count=revise_count+CASE WHEN status='waiting' THEN 1 ELSE 0 END,
        feedback=feedback || $5::jsonb WHERE ${owned} AND t.id=$3`,
        [id, note, JSON.stringify([{ text: note, attachments }])], client);
      await this.wake(job.threadId, client);
      return job.status === 'waiting' ? 'revise' : 'queued';
    });
  }
  async create(job) {
    if (job.userId) can({ id: this.ownerId }, 'modify', { type: 'personal', owner_id: job.userId });
    return transaction(this.pool, async (client) => {
      if (job.status !== "proposed") await this.queueCapacity(client, job.threadId);
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
        `INSERT INTO agent_data.tasks(instance_id,id,thread_id,text,mode,target_turn_id,turn_id,agent_hash,status,created_at,error,workflow,params,reason,model,attachments,single_workflow)
        SELECT $1,$3,$4,$5,$6,$7,NULL,$8,$12,$9,NULL,$10,$11,$13,$14,$15,$16 WHERE $2::uuid IS NOT NULL`,
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
          job.model || null,
          JSON.stringify(job.attachments || []),
          job.single === true,
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
    }).catch(async error => {
      if (error.code === '23505' && error.constraint === 'tasks_single_workflow') throw await this.singleConflict(job.workflow);
      throw error;
    });
  }
  async patch(id, fields, expected, { restoreUnsent = false } = {}) {
    const mapping = { feedback: "feedback", selectedModel: "selected_model", modelSource: "model_source", status: "status", turnId: "turn_id", error: "error", checks: "checks", step: "step", note: "note", reviseCount: "revise_count" };
    // checks 是数组：显式序列化，避免驱动把它当成 PostgreSQL 数组。
    const entries = Object.entries(fields).filter(([key]) => mapping[key])
      .map(([key, value]) => [key, ["checks", "feedback"].includes(key) && value != null ? JSON.stringify(value) : value]);
    if (!entries.length) return true;
    return transaction(this.pool, async (client) => {
      if (fields.status === "queued") {
        const current = (await this.query(`SELECT ${columns} FROM agent_data.tasks t WHERE ${owned} AND t.id=$3`, [id], client)).rows[0];
        if (!current || (expected && !expected.includes(current.status))) return false;
        // 未发出的 starting/steering 是已受理任务的回退，不是新增排队；满额不能把它变成待核对。
        const restoring = restoreUnsent && ['starting', 'steering'].includes(current.status);
        if (current.status !== 'queued' && !restoring) await this.queueCapacity(client, current.threadId);
      }
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
    const owners = (await this.systemQuery("SELECT DISTINCT c.owner_id FROM agent_data.conversations c WHERE c.instance_id=$1 AND $2::uuid IS NOT NULL")).rows;
    for (const row of owners) if (!this.sharding || this.sharding.owns(row.owner_id)) await runOwner(row.owner_id, () => this.recoverOwner(reason));
  }
  async recoverOwner(reason) {
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
    const rows = (
      await this.systemQuery(`SELECT o.thread_id,o.generation,c.owner_id FROM agent_data.outbox o
      JOIN agent_data.conversations c ON c.instance_id=o.instance_id AND c.id=o.thread_id
      WHERE o.instance_id=$1 AND $2::uuid IS NOT NULL AND NOT c.paused AND o.due_at<=now()
      AND EXISTS(SELECT 1 FROM agent_data.tasks t WHERE t.instance_id=o.instance_id AND t.thread_id=o.thread_id AND t.status='queued')
      ORDER BY o.due_at LIMIT 100`)
    ).rows;
    return this.sharding ? this.sharding.filter(rows, 'owner_id') : rows;
  }
  async delivered(row) {
    await runOwner(row.owner_id, () => this.systemQuery(
      `UPDATE agent_data.outbox SET due_at=now()+interval '5 seconds' WHERE instance_id=$1
      AND thread_id=$3 AND generation=$4 AND $2::uuid IS NOT NULL`,
      [row.thread_id, row.generation],
    ));
  }
}
