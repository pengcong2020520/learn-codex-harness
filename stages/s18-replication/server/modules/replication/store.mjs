import { businessQuery } from '../data/write.mjs';
import { transaction } from '../data/database.mjs';
import { lossStateSql, replicaTailMissing, replicaSessionMissing, takeoverAdvanced } from './loss.mjs';
export const MISSING_MESSAGE = '该轮结果在故障接管时丢失，请核对';
export const MISSING_SESSION_MESSAGE = '会话在故障接管中丢失，原会话无法恢复，请新建会话；任务记录已标记待核对';
export const LAG_MS = 5 * 60 * 1000;
export function lagOf(row, now = Date.now()) {
  const rounds = Number(row.lag_rounds || 0);
  const seconds = rounds ? Math.max(0, (now - new Date(row.pending_since).getTime()) / 1000) : 0;
  return { ...row, lag_rounds: rounds, lag_seconds: Math.floor(seconds), replica_lagging: Boolean(row.replication_error || row.transfer_started_at) || seconds > LAG_MS / 1000 };
}
export class ReplicationStore {
  constructor(pool, instanceId) { Object.assign(this, { pool, instanceId }); }
  async users(shardId) {
    return (await businessQuery(this.pool,`SELECT u.user_id FROM agent_data.user_shards u JOIN agent_data.users a ON a.id=u.user_id
      WHERE u.shard_id=$1 AND a.instance_id=$2 AND a.username IS NOT NULL ORDER BY u.user_id`, [shardId, this.instanceId])).rows.map(r => r.user_id);
  }
  async boundary(userId) {
    return (await businessQuery(this.pool,`SELECT count(*) FILTER(WHERE t.status IN ('starting','running','steering'))::int AS busy,
      coalesce(max(t.sequence) FILTER(WHERE t.status IN ('completed','failed','interrupted','needs-review','cancelled','replica_missing')),0)::text AS sequence
      FROM agent_data.tasks t JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id
      WHERE c.instance_id=$1 AND c.owner_id=$2`, [this.instanceId,userId])).rows[0];
  }
  async position(userId) { return (await businessQuery(this.pool,'SELECT * FROM agent_data.replication_positions WHERE user_id=$1',[userId])).rows[0]; }
  async unfinished(userId) { return (await businessQuery(this.pool,'SELECT * FROM agent_data.replication_transfers WHERE user_id=$1',[userId])).rows[0]; }
  async fail(userId, error) {
    await businessQuery(this.pool,'UPDATE agent_data.replication_transfers SET error=$2 WHERE user_id=$1',[userId,error.message]);
  }
  async begin(userId, route, token) {
    await businessQuery(this.pool,`INSERT INTO agent_data.replication_transfers(user_id,owner_id,shard_id,epoch,token) VALUES($1,$1,$2,$3,$4)
      ON CONFLICT(user_id) DO UPDATE SET shard_id=$2,epoch=$3,token=$4,started_at=now(),error=NULL`,[userId,route.shardId,route.epoch,token]);
  }
  async finish(userId, route, sequence, hash, token) {
    await transaction(this.pool, async db => {
      const found = await businessQuery(db,'DELETE FROM agent_data.replication_transfers WHERE user_id=$1 AND epoch=$2 AND token=$3 RETURNING user_id',[userId,route.epoch,token]);
      if (!found.rowCount) throw new Error('复制操作已失效。');
      await businessQuery(db,`INSERT INTO agent_data.replication_positions(user_id,owner_id,shard_id,epoch,last_task_sequence,content_hash,transfer_token)
        VALUES($1,$1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET shard_id=$2,epoch=$3,last_task_sequence=$4,content_hash=$5,transfer_token=$6,replicated_at=now()`,
      [userId,route.shardId,route.epoch,sequence,hash,token]);
    });
  }
  async recover(userId, epoch, { missingHome = false } = {}) {
    // Run on the new primary with runOwner and its fenced pool, before reopening dispatch.
    await transaction(this.pool, async db => {
      const rows = (await businessQuery(db,lossStateSql + ' AND s.epoch=$3',
        [this.instanceId,userId,epoch])).rows;
      for (const row of rows) {
        if (!takeoverAdvanced(row)) continue;
        if (missingHome || row.replica_missing || replicaSessionMissing(row))
          await markMissingConversation(db,this.instanceId,userId,row,{ missingHome });
        else if (replicaTailMissing(row)) await markMissingTurns(db,this.instanceId,userId,row);
      }
      await businessQuery(db,`UPDATE agent_data.tasks t SET status='unconfirmed',error='原主失联，执行结果待核对，不自动重跑。'
        FROM agent_data.conversations c WHERE c.instance_id=t.instance_id AND c.id=t.thread_id
        AND c.instance_id=$1 AND c.owner_id=$2 AND t.status IN ('starting','running','steering')`,[this.instanceId,userId]);
      await businessQuery(db,`UPDATE agent_data.conversations c SET paused=true WHERE instance_id=$1 AND owner_id=$2
        AND EXISTS(SELECT 1 FROM agent_data.tasks t WHERE t.instance_id=c.instance_id AND t.thread_id=c.id AND t.status='unconfirmed')`,[this.instanceId,userId]);
      await businessQuery(db,`INSERT INTO agent_data.outbox(instance_id,thread_id) SELECT DISTINCT t.instance_id,t.thread_id
        FROM agent_data.tasks t JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id
        WHERE c.instance_id=$1 AND c.owner_id=$2 AND t.status='queued'
        ON CONFLICT(instance_id,thread_id) DO UPDATE SET generation=outbox.generation+1,due_at=now()`,[this.instanceId,userId]);
    });
  }
  async status() {
    const rows = (await businessQuery(this.pool,`SELECT u.shard_id,u.user_id,a.username,p.last_task_sequence,p.replicated_at,
      count(t.sequence)::int AS lag_rounds,min(coalesce(t.finished_at,to_timestamp(t.created_at/1000))) AS pending_since,
      x.started_at AS transfer_started_at,x.error AS replication_error
      FROM agent_data.user_shards u JOIN agent_data.users a ON a.id=u.user_id
      JOIN agent_data.shard_owners s ON s.shard_id=u.shard_id
      LEFT JOIN agent_data.replication_positions p ON p.user_id=u.user_id AND p.epoch=s.epoch AND p.shard_id=u.shard_id
      LEFT JOIN agent_data.replication_transfers x ON x.user_id=u.user_id AND x.epoch=s.epoch
      LEFT JOIN agent_data.conversations c ON c.owner_id=u.user_id AND c.instance_id=$1
      LEFT JOIN agent_data.tasks t ON t.instance_id=c.instance_id AND t.thread_id=c.id
        AND t.status='completed' AND t.sequence>coalesce(p.last_task_sequence,0)
      WHERE a.instance_id=$1 AND a.username IS NOT NULL
      GROUP BY u.shard_id,u.user_id,a.username,p.last_task_sequence,p.replicated_at,x.started_at,x.error`,[this.instanceId])).rows;
    return rows.map(r => lagOf(r));
  }
}

// Persist before returning 409, so retries/listing and subsequent replication retain the evidence.
export async function markMissingConversation(db, instanceId, userId, row, { missingHome = false } = {}) {
  await businessQuery(db,`UPDATE agent_data.conversations SET replica_missing=true,paused=true
    WHERE instance_id=$1 AND owner_id=$2 AND id=$3`,[instanceId,userId,row.id]);
  await businessQuery(db,`UPDATE agent_data.tasks t SET status='needs-review',error=$4
    FROM agent_data.conversations c WHERE c.instance_id=t.instance_id AND c.id=t.thread_id
    AND c.instance_id=$1 AND c.owner_id=$2 AND c.id=$3 AND t.status IN ('queued','waiting','proposed')`,
  [instanceId,userId,row.id,MISSING_SESSION_MESSAGE]);
  await markMissingTurns(db,instanceId,userId,row,{missingHome});
}
export async function markMissingTurns(db, instanceId, userId, row, { missingHome = false } = {}) {
  await businessQuery(db,`UPDATE agent_data.tasks t SET status='replica_missing',error=$4
    FROM agent_data.conversations c WHERE c.instance_id=t.instance_id AND c.id=t.thread_id
    AND c.instance_id=$1 AND c.owner_id=$2 AND c.id=$3 AND t.status='completed'
    AND ($5::boolean OR t.sequence>$6::bigint)`,
  [instanceId,userId,row.id,MISSING_MESSAGE,missingHome,row.last_task_sequence || '0']);
}
