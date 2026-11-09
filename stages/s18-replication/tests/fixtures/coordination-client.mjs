// Scripted etcd3 interface double. Elections are explicitly delivered by each test;
// this fixture intentionally contains no candidate ordering or election algorithm.
import { EventEmitter } from 'node:events';
export class FakeClient {
  constructor() {
    this.kvs = new Map(); this.rev = 0n; this.leases = []; this.watchers = []; this.operations = [];
    this.leaseClient = { leaseTimeToLive: async ({ ID }) => ({ TTL: String(this.leases.find(l => l.id === ID)?.remaining ?? -1) }) };
  }
  set(key, value, lease = '0') {
    const old = this.kvs.get(key); const rev = String(++this.rev);
    const kv = { key: Buffer.from(key), value: Buffer.from(value), lease, create_revision: old?.create_revision || rev, mod_revision: rev };
    this.kvs.set(key, kv); this.broadcast('Put', kv); return kv;
  }
  remove(key) {
    const kv = this.kvs.get(key); if (!kv) return;
    this.kvs.delete(key); this.broadcast('Delete', { ...kv, mod_revision: String(++this.rev) });
  }
  broadcast(type, kv) {
    for (const w of this.watchers) if (!w.cancelled && kv.key.toString().startsWith(w.prefix)) {
      const response = { header: { revision: String(this.rev) }, events: [{ type, kv }] };
      if (w.disconnected) w.backlog.push(response); else w.emit('data', response);
    }
  }
  lease(ttl) {
    this.operations.push(['lease', ttl]);
    const lease = new EventEmitter();
    Object.assign(lease, { id: String(this.leases.length + 1), remaining: ttl, released: false,
      grant: async () => lease.id, revoked: () => lease.released,
      put: key => ({ value: async value => { this.set(key, value, lease.id); } }),
      release: () => { lease.released = true; },
      revoke: async () => { this.operations.push(['revoke', lease.id]); lease.expire(); },
      expire: () => {
        lease.released = true; lease.remaining = 0;
        for (const [key, kv] of this.kvs) if (kv.lease === lease.id) this.remove(key);
        lease.emit('lost', new Error('lease lost'));
      },
    });
    this.leases.push(lease); return lease;
  }
  get(key) { return { exec: async () => ({ header: { revision: String(this.rev) }, kvs: this.kvs.has(key) ? [this.kvs.get(key)] : [] }), key }; }
  getAll() { return { prefix: prefix => ({ exec: async () => {
    this.operations.push(['snapshot', prefix]);
    return { header: { revision: String(this.rev) }, kvs: [...this.kvs.values()].filter(kv => kv.key.toString().startsWith(prefix)) };
  } }) }; }
  put(key) { return { value: value => ({ kind: 'put', key, value }) }; }
  if(key, column, cmp, revision) {
    this.operations.push(['if', key, column, cmp, revision]);
    return { then: operation => ({ commit: async () => {
      const succeeded = this.kvs.get(key)?.create_revision === revision;
      if (succeeded && operation.kind === 'put') this.set(operation.key, operation.value);
      return { succeeded };
    } }) };
  }
  watch() {
    const options = {}; const builder = {
      prefix: prefix => { options.prefix = prefix; return builder; },
      startRevision: revision => { options.revision = revision; return builder; },
      watcher: () => {
        const w = Object.assign(new EventEmitter(), options, { backlog: [], cancel: async () => { w.cancelled = true; } });
        w.disconnect = () => { w.disconnected = true; w.emit('disconnected'); };
        w.reconnect = () => { w.disconnected = false; w.emit('connected'); for (const response of w.backlog.splice(0)) w.emit('data', response); };
        this.watchers.push(w); return w;
      },
    }; return builder;
  }
  electionFactory = lease => ({
    leader: async () => this.leaderId,
    campaign: nodeId => {
      const campaign = new EventEmitter(); const key = `/codex/controller/${lease.id}`;
      this.set(key, nodeId, lease.id);
      Object.assign(campaign, { getCampaignKey: async () => key,
        resign: async () => { this.operations.push(['resign', nodeId]); await lease.revoke(); },
        elect: () => { this.leaderId = nodeId; campaign.emit('elected'); },
      });
      return campaign;
    },
  });
  close() { this.operations.push(['close']); }
}
export const flush = () => new Promise(resolve => setImmediate(resolve));
