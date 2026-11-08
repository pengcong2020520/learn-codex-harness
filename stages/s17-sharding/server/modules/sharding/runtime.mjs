import { runOwner } from '../accounts/context.mjs';
import { unavailable } from './routing.mjs';
export class ShardRuntime {
  constructor({ nodeId, cache, coordination, key }) { Object.assign(this, { nodeId, cache, coordination, key }); this.paused = new Set(); }
  owns(userId) { return this.coordination.checkLease() && this.cache.routeOf(userId).primary === this.nodeId; }
  assertPrimary(userId) { if (!this.owns(userId)) throw unavailable('本节点不再是用户主节点。'); }
  async canDispatch(userId) {
    if (!this.owns(userId) || this.paused.has(userId)) return false;
    const row = (await this.pool.query('SELECT paused,shard_id FROM agent_data.user_shards WHERE user_id=$1', [userId])).rows[0];
    return row && !row.paused && row.shard_id === this.cache.routeOf(userId).shardId;
  }
  async admit(userId) { if (!await this.canDispatch(userId)) throw unavailable('用户正在迁移、归属尚未初始化或本节点不是分片主节点。'); }
  async filter(rows, ownerKey) {
    const accepted = [];
    for (const row of rows) if (await this.canDispatch(row[ownerKey])) accepted.push(row);
    return accepted;
  }
  async eachOwner(operation, { includePaused = false } = {}) {
    const rows = (await this.pool.query('SELECT user_id FROM agent_data.user_shards')).rows;
    for (const { user_id: id } of rows) if (this.owns(id) && (includePaused || await this.canDispatch(id))) await runOwner(id, () => operation(id));
  }
}
