import { IDLE_MS } from '../accounts/index.mjs';
import { runOwner } from '../accounts/context.mjs';
import { unavailable } from './routing.mjs';
export class ShardRuntime {
  #authorizations = new Map();
  rememberAuthorization(identity, authorization) {
    // Only called after global account authentication; never persist tokens in jobs or metadata.
    for (const [userId, entry] of this.#authorizations) if (entry.until <= Date.now()) this.#authorizations.delete(userId);
    this.#authorizations.set(identity.userId, { authorization, until: Date.now() + IDLE_MS });
  }
  authorizationFor(userId) {
    const entry = this.#authorizations.get(userId);
    return entry?.until > Date.now() ? entry.authorization : undefined;
  }
  constructor({ nodeId, cache, coordination, key, keyHashes }) { Object.assign(this, { nodeId, cache, coordination, key, keyHashes }); this.paused = new Set(); }
  owns(userId) { return this.coordination.checkLease() && this.cache.routeOf(userId).primary === this.nodeId; }
  assertPrimary(userId) { if (!this.owns(userId)) throw unavailable('本节点不再是用户主节点。'); }
  async canDispatch(userId) {
    if (!this.owns(userId) || this.paused.has(userId)) return false;
    const row = (await this.pool.query('SELECT paused,shard_id FROM agent_data.user_shards WHERE user_id=$1', [userId])).rows[0];
    return this.owns(userId) && !this.paused.has(userId) && row && !row.paused && row.shard_id === this.cache.routeOf(userId).shardId;
  }
  async admit(userId) { if (!await this.canDispatch(userId)) throw unavailable('用户正在迁移、归属尚未初始化或本节点不是分片主节点。'); }
  async routeStatus(userId) {
    const pg = (await this.pool.query('SELECT user_id,shard_id,paused FROM agent_data.user_shards WHERE user_id=$1', [userId])).rows[0] ?? null;
    // Observe the current cache without refreshing: diagnostics must not hide Watch lag.
    const routeOf = this.cache.routeOf(userId), override = this.cache.overrides[userId];
    const leaseValid = Boolean(this.coordination.checkLease()), localPaused = this.paused.has(userId);
    const owns = leaseValid && routeOf.primary === this.nodeId;
    const shardMatches = Boolean(pg && pg.shard_id === routeOf.shardId);
    return { nodeId: this.nodeId, routeOf, override: override ?? null, overrideType: typeof override,
      routeShardIdType: typeof routeOf.shardId, pgShardIdType: pg ? typeof pg.shard_id : null,
      localPaused, pg, leaseValid, owns, shardMatches, canDispatch: owns && !localPaused && Boolean(pg && !pg.paused) && shardMatches };
  }
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
