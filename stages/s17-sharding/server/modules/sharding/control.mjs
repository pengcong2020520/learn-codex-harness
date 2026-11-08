import { logFailure, diagnosticClient } from '../data/diagnostics.mjs';
import { SHARDS, defaultSlots } from './strategy.mjs';
import { transaction } from '../data/database.mjs';
import { SHARD_PREFIX, OVERRIDE_PREFIX } from './cache.mjs';
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
    await this.locked(async db => {
      const c = this.coordination;
      if (!Object.keys(this.cache.slots).length) await c.guardedPut('/codex/slots', defaultSlots());
      const used = new Set(Object.values(this.cache.shards).map(s => s.primary).filter(Boolean));
      const free = [...c.members.values()].map(m => m.nodeId).sort().filter(n => !used.has(n));
      for (const id of SHARDS) {
        let owner = this.cache.shards[id];
        // Departed primaries remain assigned. s17 never promotes or rebalances.
        if (!owner?.primary && free.length) owner = { primary: free.shift(), epoch: (owner?.epoch || 0) + 1 };
        if (!owner) owner = { primary: null, epoch: 0 };
        await db.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES($1,$2,$3)
          ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch`, [id, owner.primary, owner.epoch]);
        if (JSON.stringify(owner) !== JSON.stringify(this.cache.shards[id])) await c.guardedPut(SHARD_PREFIX + id, owner);
      }
    });
    await this.cache.refresh();
    // Account creation is global; control initializes missing mappings before first dispatch.
    await this.locked(async db => {
      await this.cache.refresh();
      const users = (await db.query('SELECT id FROM agent_data.users WHERE id NOT IN (SELECT user_id FROM agent_data.user_shards)')).rows;
      for (const [id, shardId] of Object.entries(this.cache.overrides)) {
        // A crash after etcd publish but before SQL commit remains paused until admin retries move.
        await db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND paused', [id, shardId]);
      }
      for (const { id } of users) await this.insertUser(db, id);
    });
  }
  insertUser(db, userId) { return db.query('INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, this.cache.routeOf(userId).shardId]); }
  async ensureUser(userId) { await this.locked(db => this.insertUser(db, userId)); }
  async isPaused(userId) { return (await this.pool.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1', [userId])).rows[0]?.paused; }
  async pause(userId, paused) {
    return this.locked(db => db.query('UPDATE agent_data.user_shards SET paused=$2 WHERE user_id=$1', [userId, paused]));
  }
  async switchUser(userId, shardId) {
    await this.cache.refresh();
    const old = this.cache.overrides[userId];
    const previousShard = this.cache.routeOf(userId).shardId;
    try {
      await this.locked(async db => {
        await db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1', [userId, shardId]);
        await this.coordination.guardedPut(OVERRIDE_PREFIX + userId, shardId);
      });
      await this.cache.refresh();
    } catch (error) {
      // An explicit previous-shard override is equivalent to an absent override and guardedPut is fenced.
      try {
        // COMMIT may have succeeded even when its response was lost: restore BOTH stores under a fresh term lock.
        await this.locked(async db => {
          await db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND paused=true', [userId, previousShard]);
          await this.coordination.guardedPut(OVERRIDE_PREFIX + userId, old ?? previousShard);
        });
        await this.cache.refresh();
      }
      catch { error.rollbackFailed = true; }
      throw error;
    }
  }
}
