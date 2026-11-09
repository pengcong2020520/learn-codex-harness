import { clusterKey } from '../coordination/keys.mjs';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors.mjs';
import { logFailure, diagnosticClient } from '../data/diagnostics.mjs';
import { SHARDS, defaultSlots } from './strategy.mjs';
import { transaction } from '../data/database.mjs';
export class ShardControl {
  constructor(coordination, cache, pool) { Object.assign(this, { coordination, cache, pool }); }
  async locked(operation) {
    const c = this.coordination; c.assertController(); const term = c.term();
    await c.confirm();
    return transaction(this.pool, async connection => {
      const db = diagnosticClient(connection, { nodeId: c.nodeId, term, routes: this.cache, log: this.log }, error => {
        if (error.code === 'CT001') c.isolate('database-stale-term');
      });
      await db.query('SELECT agent_data.advance_cluster_term($1::bigint)', [term]);
      await db.query("SELECT set_config('app.term',$1,true)", [String(term)]);
      await db.query('SELECT agent_data.locked_cluster_term()');
      const result = await operation(db);
      await c.confirm();
      if (c.term() !== term) throw new Error('control changed');
      return result;
    }).catch(error => {
      if (!error.databaseDiagnostic) logFailure(error, { nodeId: c.nodeId, term, routes: this.cache, log: this.log }, error, '', 'control');
      if (error.code === 'CT001') c.isolate('database-stale-term');
      throw error;
    });
  }
  reconcile() {
    return this.pending ||= this.place().finally(() => { this.pending = null; });
  }
  async place() {
    await this.cache.refresh();
    const publish = [];
    await this.locked(async db => {
      const c = this.coordination;
      if (!Object.keys(this.cache.slots).length) publish.push([clusterKey(this.coordination.client, 'slots'), defaultSlots()]);
      const used = new Set(Object.values(this.cache.shards).map(s => s.primary).filter(Boolean));
      const free = [...c.members.values()].map(m => m.nodeId).sort().filter(n => !used.has(n));
      for (const id of SHARDS) {
        let owner = this.cache.shards[id];
        // Departed primaries remain assigned. s18 never promotes or rebalances.
        if (!owner?.primary && free.length) owner = { primary: free.shift(), epoch: (owner?.epoch || 0) + 1 };
        if (!owner) owner = { primary: null, epoch: 0 };
        // Reassignment invalidates the old replica baseline in the same fenced transaction.
        await db.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES($1,$2,$3)
          ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch,
            replica=CASE WHEN shard_owners.node_id IS NOT DISTINCT FROM EXCLUDED.node_id AND shard_owners.epoch=EXCLUDED.epoch THEN shard_owners.replica ELSE NULL END,
            replica_ready=CASE WHEN shard_owners.node_id IS NOT DISTINCT FROM EXCLUDED.node_id AND shard_owners.epoch=EXCLUDED.epoch THEN shard_owners.replica_ready ELSE false END,
            previous_primary=CASE WHEN shard_owners.node_id IS NOT DISTINCT FROM EXCLUDED.node_id AND shard_owners.epoch=EXCLUDED.epoch THEN shard_owners.previous_primary ELSE NULL END`, [id, owner.primary, owner.epoch]);
        if (JSON.stringify(owner) !== JSON.stringify(this.cache.shards[id])) publish.push([clusterKey(this.coordination.client, 'shards/') + id, owner]);
      }
    });
    for (const [key, value] of publish) await this.coordination.guardedPut(key, value);
    await this.cache.refresh();
    // Account creation is global; control initializes missing mappings before first dispatch.
    await this.locked(async db => {
      await this.cache.refresh();
      const users = (await db.query('SELECT id FROM agent_data.users WHERE id NOT IN (SELECT user_id FROM agent_data.user_shards)')).rows;
      for (const [id, shardId] of Object.entries(this.cache.overrides)) {
        const op = (await db.query('SELECT * FROM agent_data.move_operations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0];
        if (!op || !['switched','resumed'].includes(op.state) || op.to_shard !== shardId) {
          (this.log || console.error)(`拒绝未完成迁移的 override: user=${id}, state=${op?.state || 'missing'}`);
          continue;
        }
        await db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND paused', [id, shardId]);
      }
      for (const { id } of users) await this.insertUser(db, id);
    });
  }
  insertUser(db, userId) { return db.query('INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, String(this.cache.strategy.shardOf(userId, this.cache))]); }
  async ensureUser(userId) { await this.locked(db => this.insertUser(db, userId)); }
  async isPaused(userId) { return (await this.pool.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1', [userId])).rows[0]?.paused; }
  async pause(userId, paused) {
    return this.locked(db => db.query('UPDATE agent_data.user_shards SET paused=$2 WHERE user_id=$1', [userId, paused]));
  }
  async beginMove(userId, shardId) {
    return this.locked(async db => {
      const source = (await db.query(`SELECT u.*,s.node_id FROM agent_data.user_shards u JOIN agent_data.shard_owners s USING(shard_id) WHERE user_id=$1 FOR UPDATE OF u`, [userId])).rows[0];
      const target = (await db.query('SELECT node_id FROM agent_data.shard_owners WHERE shard_id=$1', [shardId])).rows[0];
      if (source?.shard_id === shardId && !source.paused) return null;
      if (!source?.node_id || !target?.node_id || source.paused) throw new AppError('用户已暂停或目标无效；请先核对未完成操作单。', 409);
      const id = randomUUID();
      const op = (await db.query(`INSERT INTO agent_data.move_operations(id,user_id,from_shard,to_shard,control_node,source_node,target_node,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'paused') RETURNING *`, [id,userId,source.shard_id,shardId,this.coordination.nodeId,source.node_id,target.node_id])).rows[0];
      await db.query('UPDATE agent_data.user_shards SET paused=true WHERE user_id=$1', [userId]);
      return op;
    });
  }
  advanceMove(id, from, to) {
    // Node acknowledgements reach this control entry; callers cannot supply an unfenced pool/client.
    return this.locked(db => this.#advanceMove(db, id, from, to));
  }
  async #advanceMove(connection, id, from, to) {
    const result = await connection.query(`UPDATE agent_data.move_operations SET state=$3 WHERE id=$1 AND state=$2 AND expires_at>now() AND control_node=$4 RETURNING *`, [id,from,to,this.coordination.nodeId]);
    if (!result.rows[0]) throw new AppError('操作单过期、状态或 control 不匹配。', 403, 'MOVE_OPERATION');
    return result.rows[0];
  }
  async failMove(operationId, previousTerm = this.coordination.term()) {
    // Failure recording must work when etcd is unavailable. Never advance the term here:
    // the PG guard rejects a former control once a newer control has acquired the fence.
    const term = String(previousTerm);
    await transaction(this.pool, async db => {
      await db.query("SELECT set_config('app.term',$1,true),agent_data.locked_cluster_term()", [term]);
      const op = (await db.query("UPDATE agent_data.move_operations SET state='failed' WHERE id=$1 RETURNING *", [operationId])).rows[0];
      if (op) await db.query('UPDATE agent_data.user_shards SET paused=true WHERE user_id=$1', [op.user_id]);
    });
  }
  async finishMove(op) {
    await this.locked(async db => {
      await this.#advanceMove(db, op.id, 'switched', 'resumed');
      const result = await db.query('UPDATE agent_data.user_shards SET paused=false WHERE user_id=$1 AND shard_id=$2 RETURNING user_id', [op.user_id,op.to_shard]);
      if (!result.rows[0]) throw new AppError('恢复前用户归属变化。', 409);
    });
  }
  async switchUser(userId, shardId, operationId) {
    const term = this.coordination.term();
    try {
      await this.locked(async db => {
        const op = await this.#advanceMove(db, operationId, 'copied', 'switched');
        if (op.user_id !== userId || op.to_shard !== shardId) throw new AppError('操作单用户或目标不匹配。', 403);
        const result = await db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND shard_id=$3 AND paused RETURNING user_id', [userId,shardId,op.from_shard]);
        if (!result.rows[0]) throw new AppError('源分片或暂停状态变化。', 409);
      }); // COMMIT must complete before publishing the override.
      await this.coordination.guardedPut(clusterKey(this.coordination.client, 'overrides/') + userId, JSON.stringify(shardId));
      await this.cache.refresh();
    } catch (error) {
      await this.failMove(operationId, term).catch(() => { error.rollbackFailed = true; });
      (this.log || console.error)(`迁移切换失败，用户保持暂停: operation=${operationId}, user=${userId}`);
      throw error;
    }
  }
}
