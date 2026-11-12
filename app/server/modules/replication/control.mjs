import { assertClusterOwners } from '../config/cluster.mjs';
import { clusterKey } from '../coordination/keys.mjs';
import { ShardControl } from '../sharding/control.mjs';
import { SHARDS, defaultSlots } from '../sharding/strategy.mjs';
import { AppError } from '../../../shared/errors.mjs';
export const hasMember = (members, nodeId) => Boolean(nodeId) && (members.has(nodeId) || [...members.values()].some(m => m.nodeId === nodeId));
export const ring = (id, nodes = ['node-a']) => ({ primary: nodes[Number(id) % nodes.length], replica: nodes.length > 1 ? nodes[(Number(id) + 1) % nodes.length] : null, epoch: 1 });
export const wireOwner = row => ({ primary: row.node_id, replica: row.replica, epoch: Number(row.epoch) });
export function takeoverReason(row, online, transferring = false) {
  if (!row.replica || !hasMember(online,row.replica)) return '副本不在线';
  if (!row.replica_ready) return '副本尚未追平';
  if (transferring) return '副本目录复制尚未完整提交';
  if (row.publishing || row.recovering || row.paused) return '分片仍在切换或恢复';
  return null;
}
export class ReplicationControl extends ShardControl {
  constructor(coordination, cache, pool, instanceId, nodes = ['node-a']) {
    super(coordination, cache, pool);
    if (!instanceId) throw new TypeError('ReplicationControl requires instanceId');
    this.instanceId = instanceId;
    this.nodes = nodes;
    this.reasons = new Map();
  }
  async rows() { return (await this.pool.query('SELECT * FROM agent_data.shard_owners ORDER BY shard_id')).rows; }
  async place() {
    // Keep existing primaries when nodes are added; never automatically rebalance.
    assertClusterOwners(await this.rows(), this.nodes);
    await this.locked(async db => {
      for (const id of SHARDS) {
        const r = ring(id, this.nodes);
        await db.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch,replica,publishing) VALUES($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`,[id,r.primary,r.epoch,r.replica]);
      }
    });
    await this.publish();
    await this.locked(async db => {
      const users = (await db.query('SELECT id FROM agent_data.users WHERE instance_id=$1 AND id NOT IN (SELECT user_id FROM agent_data.user_shards)',[this.instanceId])).rows;
      for (const {id} of users) await this.insertUser(db,id);
    });
    for (const row of await this.rows()) {
      if (!hasMember(this.coordination.members,row.node_id)) {
        try { await this.switch(row.shard_id); this.reasons.delete(row.shard_id); }
        catch (error) { if (error.code !== 'REPLICA_UNAVAILABLE') throw error; this.reasons.set(row.shard_id,error.message); }
      } else if (!row.replica && !row.previous_primary && this.nodes.length > 1) {
        const replica = this.nodes[(this.nodes.indexOf(row.node_id) + 1) % this.nodes.length];
        if (hasMember(this.coordination.members, replica)) await this.locked(db => db.query(`UPDATE agent_data.shard_owners SET replica=$2,replica_ready=false,publishing=true
          WHERE shard_id=$1 AND node_id=$3 AND replica IS NULL AND previous_primary IS NULL AND NOT recovering AND NOT publishing`, [row.shard_id, replica, row.node_id]));
      } else if (this.nodes.length > 1 && !row.replica && this.nodes.includes(row.previous_primary) && hasMember(this.coordination.members,row.previous_primary)) {
        await this.locked(db => db.query(`UPDATE agent_data.shard_owners SET replica=previous_primary,replica_ready=false,publishing=true
          WHERE shard_id=$1 AND replica IS NULL AND previous_primary<>node_id AND NOT recovering AND NOT publishing`,[row.shard_id]));
      }
    }
    await this.publish();
  }
  async publish() {
    const rows = await this.rows();
    // All values came from committed PG state, including reconciliation after an earlier failed put.
    if (!Object.keys(this.cache.slots).length) await this.coordination.guardedPut(clusterKey(this.coordination.client, 'slots'),defaultSlots());
    for (const row of rows) {
      const owner = wireOwner(row);
      if (row.publishing || JSON.stringify(this.cache.shards[row.shard_id]) !== JSON.stringify(owner)) {
        await this.coordination.guardedPut(clusterKey(this.coordination.client, 'shards/')+row.shard_id,owner);
        await this.locked(db => db.query(`UPDATE agent_data.shard_owners SET publishing=false WHERE shard_id=$1 AND epoch=$2 AND node_id=$3 AND replica IS NOT DISTINCT FROM $4`,[row.shard_id,row.epoch,row.node_id,row.replica]));
      }
    }
    await this.cache.refresh();
  }
  async switch(shardId, { manual = false } = {}) {
    if (!SHARDS.includes(shardId)) throw new AppError('无效分片。',400);
    const result = await this.locked(async db => {
      const row = (await db.query('SELECT * FROM agent_data.shard_owners WHERE shard_id=$1 FOR UPDATE',[shardId])).rows[0];
      const transfer = await this.missingSnapshots(db,shardId,row.epoch);
      const reason = takeoverReason({...row, paused: manual ? false : row.paused},this.coordination.members,Boolean(transfer));
      if (reason) throw new AppError(reason,409,'REPLICA_UNAVAILABLE');
      if (!manual && hasMember(this.coordination.members,row.node_id)) throw new AppError('主节点仍在线。',409,'REPLICA_UNAVAILABLE');
      if (manual && !row.paused) throw new AppError('手动切换要求先暂停。',409);
      await db.query(`UPDATE agent_data.shard_owners SET previous_primary=node_id,node_id=replica,replica=NULL,
        epoch=epoch+1,replica_ready=false,publishing=true,recovering=true,paused=false WHERE shard_id=$1`,[shardId]);
      return { shardId, primary: row.replica, epoch: Number(row.epoch)+1 };
    });
    await this.publish(); return result;
  }
  async missingSnapshots(db, shardId, epoch) {
    // Match ReplicationStore.users(): workers only copy this deployment's named accounts.
    // A position from another shard/epoch cannot satisfy the current baseline; an active
    // transfer invalidates even an existing position until both directory imports commit.
    return (await db.query(`SELECT 1 FROM agent_data.user_shards u JOIN agent_data.users a ON a.id=u.user_id
      LEFT JOIN agent_data.replication_positions p ON p.user_id=u.user_id AND p.shard_id=u.shard_id AND p.epoch=$2
      LEFT JOIN agent_data.replication_transfers x ON x.user_id=u.user_id AND x.shard_id=u.shard_id AND x.epoch=$2
      WHERE u.shard_id=$1 AND a.instance_id=$3 AND a.username IS NOT NULL
        AND (p.user_id IS NULL OR x.user_id IS NOT NULL) LIMIT 1`,[shardId,epoch,this.instanceId])).rowCount;
  }
  async ready(shardId, epoch, caller) {
    return this.locked(async db => {
      const row = (await db.query('SELECT * FROM agent_data.shard_owners WHERE shard_id=$1 FOR UPDATE',[shardId])).rows[0];
      if (!row || row.node_id !== caller || String(row.epoch)!==String(epoch) || !row.replica || row.publishing || row.recovering) throw new AppError('复制主节点或 epoch 已改变。',409);
      const missing = await this.missingSnapshots(db,shardId,epoch);
      if (missing) return { ready: false };
      await db.query('UPDATE agent_data.shard_owners SET replica_ready=true WHERE shard_id=$1',[shardId]);
      return {ready:true};
    });
  }
  async recovered(shardId, epoch, caller) {
    return this.locked(async db => {
      const result = await db.query('UPDATE agent_data.shard_owners SET recovering=false WHERE shard_id=$1 AND epoch=$2 AND node_id=$3 AND NOT publishing RETURNING shard_id',[shardId,epoch,caller]);
      if (!result.rowCount) throw new AppError('恢复确认已过期。',409);
      return { recovered:true };
    });
  }
  async promote(shardId, sync) {
    if (!SHARDS.includes(shardId)) throw new AppError('无效分片。',400);
    const row = await this.locked(async db => {
      const r = (await db.query('SELECT * FROM agent_data.shard_owners WHERE shard_id=$1 FOR UPDATE',[shardId])).rows[0];
      const reason=takeoverReason({...r,paused:false},this.coordination.members);
      if(reason) throw new AppError(reason,409,'REPLICA_UNAVAILABLE');
      await db.query('UPDATE agent_data.shard_owners SET paused=true WHERE shard_id=$1',[shardId]); return r;
    });
    // Failure deliberately leaves the durable pause in place. Retry resumes this operation explicitly.
    await sync(row);
    return this.switch(shardId,{manual:true});
  }
}
