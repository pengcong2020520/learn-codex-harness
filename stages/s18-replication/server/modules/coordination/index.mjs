import { clusterKey } from './keys.mjs';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../../shared/errors.mjs';
export const TTL = 10;
export const MEMBERS = '/codex/members/';
export const notController = () => new AppError('当前节点不是有效 control。', 409, 'NOT_CONTROLLER');
const nextRevision = value => (BigInt(value) + 1n).toString();
export const compacted = error => (error?.compact_revision != null && BigInt(error.compact_revision) > 0n) || /compact/i.test(`${error?.name} ${error?.message}`);

export class Coordination extends EventEmitter {
  constructor({ client, electionFactory, nodeId, address, revision, agentHash, capacity,
    now = () => performance.now(), clock = () => new Date().toISOString() }) {
    super();
    if (!/^node-[abc]$/.test(nodeId)) throw new Error('AGENT_NODE_ID 必须是 node-a、node-b 或 node-c。');
    Object.assign(this, { client, electionFactory, nodeId, address, revision, agentHash, capacity, now, clock });
    this.membersPrefix = clusterKey(client, 'members/');
    this.members = new Map(); this.events = []; this.memberRevision = '0';
    this.alive = false; this.controller = false; this.closed = false; this.generation = 0;
  }
  record(type, detail = {}) {
    this.events.push({ type, ...detail, at: this.clock() });
    if (this.events.length > 20) this.events.shift();
    this.emit('event', this.events.at(-1));
  }
  async join() {
    if (this.closed || this.alive) throw new Error('节点已关闭或已经加入。');
    const epoch = ++this.generation;
    const lease = this.client.lease(TTL); // automatic KeepAlive, TTL/3, owned by etcd3
    this.lease = lease;
    lease.on('lost', () => { if (this.generation === epoch && this.lease === lease) this.isolate('lease-lost'); });
    lease.on('keepaliveSucceeded', () => {
      if (this.generation !== epoch || this.lease !== lease) return;
      // A delayed reply after a process pause must never revive the old generation.
      if (this.alive && this.now() - this.lastKeepAlive >= TTL * 1000) this.isolate('keepalive-timeout');
      if (this.alive && this.lease === lease) { this.lastKeepAlive = this.now(); this.armDeadline(); }
    });
    lease.on('keepaliveFailed', () => { if (this.generation === epoch) this.checkLease(); });
    await lease.grant();
    if (epoch !== this.generation || lease.revoked() || this.closed) throw notController();
    this.lastKeepAlive = this.now(); this.alive = true;
    this.armDeadline();
    const member = { nodeId: this.nodeId, address: this.address, revision: this.revision,
      agentHash: this.agentHash, capacity: this.capacity, joinedAt: this.clock() };
    await lease.put(this.membersPrefix + this.nodeId).value(JSON.stringify(member));
    if (epoch !== this.generation || !this.checkLease()) throw notController();
    this.record('joined', { nodeId: this.nodeId });
  }
  armDeadline() {
    clearTimeout(this.timer);
    const epoch = this.generation;
    this.timer = setTimeout(() => {
      if (epoch === this.generation && this.checkLease()) this.armDeadline();
    }, Math.max(0, TTL * 1000 - (this.now() - this.lastKeepAlive)));
    this.timer.unref?.();
  }
  checkLease() {
    if (this.alive && (this.lease.revoked() || this.now() - this.lastKeepAlive >= TTL * 1000)) this.isolate('keepalive-timeout');
    return this.alive && !this.closed;
  }
  isController() { return this.checkLease() && this.controller; }
  term() { return this.isController() ? this.ownTerm : null; }
  assertController() { if (!this.isController()) throw notController(); }
  isolate(reason) {
    if (!this.alive && !this.controller) return;
    this.alive = false; this.controller = false; this.generation++;
    clearInterval(this.reconcileTimer); clearTimeout(this.watchRetry);
    clearTimeout(this.timer);
    this.lease?.release(); // no more automatic renewals after local fencing
    this.record('isolated', { nodeId: this.nodeId, reason });
    this.emit('lost', reason); // synchronous admission/result fence before any await
  }
  async refreshMembers(epoch = this.generation) {
    const snapshot = await this.client.getAll().prefix(this.membersPrefix).exec();
    if (this.closed || epoch !== this.generation || BigInt(snapshot.header.revision) < BigInt(this.snapshotRevision || '0')) return;
    this.snapshotRevision = snapshot.header.revision;
    // A Watch event delivered while the read was in flight can be newer than its snapshot.
    // Replay that suffix over the authoritative replacement, never regress the revision.
    const suffix = (this.memberEvents || []).filter(e => BigInt(e.kv.mod_revision) > BigInt(snapshot.header.revision));
    const before = JSON.stringify([...this.members]);
    this.members = new Map();
    for (const kv of snapshot.kvs) this.applyMember('Put', kv, false);
    this.memberRevision = snapshot.header.revision;
    for (const event of suffix) { this.applyMember(event.type, event.kv, false); this.memberRevision = event.kv.mod_revision; }
    this.memberEvents = suffix;
    this.record('members-snapshot', { revision: this.memberRevision });
    if (before !== JSON.stringify([...this.members])) {
      this.record('members-reconciled'); this.emit('members');
    }
  }
  async watchMembers() {
    const epoch = this.generation;
    // A rejoin or explicit reload must not orphan the previous etcd3 Watch.
    const previous = this.watcher; this.watcher = null;
    await previous?.cancel();
    if (epoch !== this.generation || this.closed) return;
    this.memberEvents = []; this.memberRevision = '0';
    await this.refreshMembers(epoch);
    if (epoch !== this.generation || this.closed) return;
    this.attachWatch(epoch);
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => {
      if (epoch === this.generation) void this.reconcile().catch(() => { if (epoch === this.generation) this.record('reconcile-failed'); });
    }, 5000);
    this.reconcileTimer.unref?.();
  }
  async reconcile() {
    if (this.reconciling || this.closed || !this.alive) return;
    this.reconciling = true;
    const epoch = this.generation;
    try { await this.refreshMembers(epoch); await this.observeControl(epoch); }
    finally { this.reconciling = false; }
  }
  applyMember(type, kv, log = true) {
    const key = kv.key.toString();
    if (type === 'Delete') this.members.delete(key);
    else {
      try {
        const member = JSON.parse(kv.value.toString());
        if (!member || typeof member !== 'object' || Array.isArray(member)) throw new Error('invalid member');
        this.members.set(key, { ...member, leaseId: kv.lease });
      } catch {
        this.members.delete(key); this.record('member-invalid', { key }); return;
      }
    }
    if (log) this.record(type === 'Delete' ? 'member-left' : 'member-put', { nodeId: key.slice(this.membersPrefix.length) });
  }
  attachWatch(epoch = this.generation) {
    if (this.closed || epoch !== this.generation) return;
    const watcher = this.client.watch().prefix(this.membersPrefix).startRevision(nextRevision(this.memberRevision)).watcher();
    this.watcher = watcher;
    const current = () => this.watcher === watcher && epoch === this.generation && !this.closed;
    const restart = error => {
      if (!current()) return;
      if (compacted(error)) this.record('watch-compacted');
      this.watcher = null;
      void this.restartWatch(watcher, epoch);
    };
    watcher.on('data', response => {
      if (!current()) return;
      if (compacted(response)) { restart(response); return; }
      const previousRevision = BigInt(this.memberRevision);
      for (const event of response.events || []) {
        if (BigInt(event.kv.mod_revision) <= previousRevision) continue;
        this.applyMember(event.type, event.kv);
        this.memberEvents.push(event);
        this.memberRevision = event.kv.mod_revision;
      }
      this.emit('members');
    });
    watcher.on('disconnected', () => { if (current()) this.record('watch-disconnected', { revision: this.memberRevision }); });
    watcher.on('connected', response => {
      if (!current()) return;
      if (compacted(response)) { restart(response); return; }
      this.record('watch-connected', { revision: this.memberRevision });
      void this.refreshMembers(epoch).catch(restart);
    });
    watcher.on('error', restart);
  }
  async restartWatch(watcher, epoch) {
    await watcher.cancel().catch(() => {});
    if (this.closed || epoch !== this.generation) return;
    try { await this.watchMembers(); }
    catch {
      if (epoch !== this.generation || this.closed) return;
      this.watchRetry = setTimeout(() => { void this.restartWatch(watcher, epoch); }, 2000);
      this.watchRetry.unref?.();
    }
  }
  campaign() {
    if (!this.checkLease()) throw notController();
    const epoch = this.generation;
    this.election = this.electionFactory(this.lease);
    const campaign = this.election.campaign(this.nodeId);
    this.candidate = campaign;
    campaign.on('error', () => { if (epoch === this.generation && this.candidate === campaign) this.isolate('election-lost'); });
    campaign.on('elected', () => { if (epoch === this.generation) void this.elected(campaign, epoch).catch(() => { if (epoch === this.generation) this.isolate('term-unconfirmed'); }); });
    return campaign;
  }
  async elected(campaign, epoch) {
    const key = await campaign.getCampaignKey();
    const { kvs } = await this.client.get(key).exec();
    if (epoch !== this.generation || this.candidate !== campaign || !this.checkLease()) return;
    const kv = kvs[0];
    if (!kv || kv.value.toString() !== this.nodeId || kv.lease !== await this.lease.grant()) throw notController();
    if (epoch !== this.generation || this.candidate !== campaign || !this.checkLease()) return;
    this.electionKey = key; this.ownTerm = kv.create_revision; this.controller = true;
    await this.confirm();
    if (epoch !== this.generation) return;
    this.record('elected', { nodeId: this.nodeId, term: this.ownTerm });
    this.emit('controller', this.ownTerm);
  }
  async confirm() {
    this.assertController();
    const epoch = this.generation;
    const result = await this.client.if(this.electionKey, 'Create', '==', this.ownTerm).then(this.client.get(this.electionKey)).commit();
    if (epoch !== this.generation) throw notController();
    if (!result.succeeded) { this.isolate('stale-term'); throw notController(); }
    this.assertController();
  }
  async guardedPut(key, value) {
    this.assertController();
    const epoch = this.generation;
    const result = await this.client.if(this.electionKey, 'Create', '==', this.ownTerm)
      .then(this.client.put(key).value(typeof value === 'string' ? value : JSON.stringify(value))).commit();
    if (epoch !== this.generation) throw notController();
    if (!result.succeeded) { this.isolate('stale-term'); throw notController(); }
    this.assertController();
  }
  async writeInfo() {
    return this.guardedPut(clusterKey(this.client, 'cluster/info'), { members: this.members.size, term: this.term(), at: this.clock() });
  }
  async status() {
    const epoch = this.generation;
    const members = await Promise.all([...this.members.values()].map(async member => {
      const { TTL: remaining } = await this.client.leaseClient.leaseTimeToLive({ ID: member.leaseId });
      return { ...member, ttl: Math.max(0, Number(remaining)) };
    }));
    const control = await this.observeControl(epoch);
    return { members, control, events: [...this.events] };
  }
  async observeControl(epoch = this.generation) {
    const snapshot = await this.client.getAll().prefix(clusterKey(this.client, 'controller/')).exec();
    if (this.closed || epoch !== this.generation) return null;
    const kv = snapshot.kvs.sort((a, b) => BigInt(a.create_revision) < BigInt(b.create_revision) ? -1 : 1)[0];
    const control = kv ? { nodeId: kv.value.toString(), term: kv.create_revision } : null;
    if (JSON.stringify(control) !== JSON.stringify(this.observedControl)) {
      this.observedControl = control; this.record('control-reconciled', { control });
    }
    if (this.controller && (control?.nodeId !== this.nodeId || control?.term !== this.ownTerm)) this.isolate('control-reconciled');
    return control;
  }
  async leaveGeneration() {
    this.lease?.release();
    clearInterval(this.reconcileTimer); clearTimeout(this.watchRetry);
    const watcher = this.watcher; this.watcher = null;
    const candidate = this.candidate; this.candidate = null;
    await watcher?.cancel().catch(() => {});
    await candidate?.resign().catch(() => {});
    await this.lease?.revoke().catch(() => {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true; this.isolate('shutdown');
    clearTimeout(this.timer); clearTimeout(this.watchRetry); clearInterval(this.reconcileTimer);
    // Campaign.resign also revokes the shared lease. Explicit revoke is idempotent.
    try { await this.candidate?.resign(); }
    finally {
      try { await this.lease?.revoke(); }
      finally { try { await this.watcher?.cancel(); } finally { this.client.close(); } }
    }
  }
}
