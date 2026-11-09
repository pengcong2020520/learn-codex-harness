import { clusterKey } from '../coordination/keys.mjs';
import { EventEmitter } from 'node:events';
import { strategy, SHARDS } from './strategy.mjs';
import { compacted } from '../coordination/index.mjs';
export const SHARD_PREFIX = '/codex/shards/';
export const OVERRIDE_PREFIX = '/codex/overrides/';
// Read the common prefix once so all three maps describe ONE MVCC revision.
export class RouteCache extends EventEmitter {
  constructor(client, name = 'slots') {
    super(); this.client = client; this.strategy = strategy(name);
    this.prefix = clusterKey(client, '');
    this.shardPrefix = clusterKey(client, 'shards/'); this.overridePrefix = clusterKey(client, 'overrides/');
    this.shards = {}; this.slots = {}; this.overrides = {}; this.revision = '0'; this.events = [];
  }
  apply(type, kv) {
    const key = kv.key.toString();
    if (!(key.startsWith(this.shardPrefix) || key === this.prefix + 'slots' || key.startsWith(this.overridePrefix))) return;
    const target = key.startsWith(this.shardPrefix) ? this.shards : key.startsWith(this.overridePrefix) ? this.overrides : null;
    const id = key.split('/').at(-1);
    if (type === 'Delete') { if (target) delete target[id]; else this.slots = {}; }
    else { const value = JSON.parse(kv.value.toString()); if (target) target[id] = value; else this.slots = value; }
  }
  async refresh() {
    const snapshot = await this.client.getAll().prefix(this.prefix).exec();
    if (this.closed || BigInt(snapshot.header.revision) < BigInt(this.snapshotRevision || 0)) return;
    const suffix = this.events.filter(e => BigInt(e.kv.mod_revision) > BigInt(snapshot.header.revision));
    this.shards = {}; this.slots = {}; this.overrides = {};
    for (const kv of snapshot.kvs) this.apply('Put', kv);
    this.snapshotRevision = this.revision = String(snapshot.header.revision);
    for (const event of suffix) { this.apply(event.type, event.kv); this.revision = String(event.kv.mod_revision); }
    this.events = suffix; this.emit('change');
  }
  async open() {
    await this.refresh(); if (this.closed) return this; this.watch();
    this.timer = setInterval(() => { void this.refresh().catch(() => this.emit('degraded')); }, 5000);
    this.timer.unref?.(); return this;
  }
  watch() {
    if (this.closed) return;
    // One prefix Watch includes shards/, the exact slots key and overrides/ atomically.
    const watcher = this.client.watch().prefix(this.prefix).startRevision((BigInt(this.revision) + 1n).toString()).watcher();
    this.watcher = watcher;
    const current = () => this.watcher === watcher && !this.closed;
    const restart = () => {
      if (!current()) return;
      this.watcher = null;
      void watcher.cancel().catch(() => {}).then(() => this.reconnect());
    };
    watcher.on('data', response => {
      if (!current()) return;
      if (compacted(response)) return restart();
      const before = BigInt(this.revision);
      try {
        for (const event of response.events || []) {
          if (BigInt(event.kv.mod_revision) <= before) continue;
          this.apply(event.type, event.kv); this.events.push(event);
          this.revision = String(event.kv.mod_revision);
        }
        this.emit('change');
      } catch { restart(); }
    });
    watcher.on('disconnected', restart); watcher.on('error', restart);
  }
  async reconnect() {
    if (this.closed) return;
    try { await this.refresh(); if (this.closed) return this; this.watch(); }
    catch { if (this.closed) return; this.retry = setTimeout(() => { void this.reconnect(); }, 1000); this.retry.unref?.(); }
  }
  routeOf(userId) {
    // Older controls wrote bare 0/1/2: JSON.parse turns those bytes into numbers.
    // Keep the raw override for diagnostics, but all routing/PG comparisons use text IDs.
    const raw = this.overrides[userId] ?? this.strategy.shardOf(userId, this);
    const shardId = ['string', 'number'].includes(typeof raw) && SHARDS.includes(String(raw)) ? String(raw) : null;
    const owner = this.shards[shardId];
    return { shardId, primary: owner?.primary ?? null, replica: owner?.replica ?? null, epoch: owner?.epoch ?? null, revision: this.revision };
  }
  close() {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.retry);
    const watcher = this.watcher; this.watcher = null;
    return this.closing ||= Promise.resolve().then(() => watcher?.cancel());
  }
}
