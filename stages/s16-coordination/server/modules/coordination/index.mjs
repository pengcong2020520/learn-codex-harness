import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../../shared/errors.mjs';
export const TTL = 10;
export const MEMBERS = '/codex/members/';
export const notController = () => new AppError('当前节点不是有效 control。', 409, 'NOT_CONTROLLER');
const nextRevision = value => (BigInt(value) + 1n).toString();
const compacted = error => /compact/i.test(`${error?.name} ${error?.message}`);

export class Coordination extends EventEmitter {
  constructor({ client, electionFactory, nodeId, address, revision, agentHash, capacity,
    now = () => performance.now(), clock = () => new Date().toISOString() }) {
    super();
    if (!/^node-[abc]$/.test(nodeId)) throw new Error('AGENT_NODE_ID 必须是 node-a、node-b 或 node-c。');
    Object.assign(this, { client, electionFactory, nodeId, address, revision, agentHash, capacity, now, clock });
    this.members = new Map(); this.events = []; this.memberRevision = '0';
    this.alive = false; this.controller = false; this.closed = false;
  }
  record(type, detail = {}) {
    this.events.push({ type, ...detail, at: this.clock() });
    if (this.events.length > 20) this.events.shift();
    this.emit('event', this.events.at(-1));
  }
  async join() {
    if (this.closed || this.alive) throw new Error('节点已关闭或已经加入。');
    const lease = this.client.lease(TTL); // automatic KeepAlive, TTL/3, owned by etcd3
    this.lease = lease;
    lease.on('lost', () => { if (this.lease === lease) this.isolate('lease-lost'); });
    lease.on('keepaliveSucceeded', () => {
      // A delayed reply after a process pause must never revive the old generation.
      if (this.alive && this.now() - this.lastKeepAlive >= TTL * 1000) this.isolate('keepalive-timeout');
      if (this.alive && this.lease === lease) { this.lastKeepAlive = this.now(); this.armDeadline(); }
    });
    lease.on('keepaliveFailed', () => { this.checkLease(); });
    await lease.grant();
    if (lease.revoked() || this.closed) throw notController();
    this.lastKeepAlive = this.now(); this.alive = true;
    this.armDeadline();
    const member = { nodeId: this.nodeId, address: this.address, revision: this.revision,
      agentHash: this.agentHash, capacity: this.capacity, joinedAt: this.clock() };
    await lease.put(MEMBERS + this.nodeId).value(JSON.stringify(member));
    this.checkLease();
    this.record('joined', { nodeId: this.nodeId });
  }
  armDeadline() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.checkLease()) this.armDeadline();
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
    this.alive = false; this.controller = false;
    clearTimeout(this.timer);
    this.lease?.release(); // no more automatic renewals after local fencing
    this.record('isolated', { nodeId: this.nodeId, reason });
    this.emit('lost', reason); // synchronous admission/result fence before any await
  }
  async watchMembers() {
    const snapshot = await this.client.getAll().prefix(MEMBERS).exec();
    if (this.closed) return;
    this.members.clear();
    for (const kv of snapshot.kvs) this.applyMember('Put', kv, false);
    this.memberRevision = snapshot.header.revision;
    this.record('members-snapshot', { revision: this.memberRevision });
    this.attachWatch();
  }
  applyMember(type, kv, log = true) {
    const key = kv.key.toString();
    if (type === 'Delete') this.members.delete(key);
    else this.members.set(key, { ...JSON.parse(kv.value.toString()), leaseId: kv.lease });
    if (log) this.record(type === 'Delete' ? 'member-left' : 'member-put', { nodeId: key.slice(MEMBERS.length) });
  }
  attachWatch() {
    if (this.closed) return;
    const watcher = this.client.watch().prefix(MEMBERS).startRevision(nextRevision(this.memberRevision)).watcher();
    this.watcher = watcher;
    watcher.on('data', response => {
      if (this.watcher !== watcher || this.closed) return;
      for (const event of response.events || []) this.applyMember(event.type, event.kv);
      // Watch create headers may be ahead of replayed events; only advance on data.
      if (response.events?.length) this.memberRevision = response.events.at(-1).kv.mod_revision;
      this.emit('members');
    });
    // etcd3 resumes at the last delivered revision + 1 itself on transport loss.
    watcher.on('disconnected', () => this.record('watch-disconnected', { revision: this.memberRevision }));
    watcher.on('connected', () => this.record('watch-connected', { revision: this.memberRevision }));
    watcher.on('error', error => {
      if (this.watcher !== watcher || this.closed) return;
      this.watcher = null;
      void this.restartWatch(watcher, compacted(error));
    });
  }
  async restartWatch(watcher, reload) {
    await watcher.cancel().catch(() => {});
    if (this.closed) return;
    try { if (reload) await this.watchMembers(); else this.attachWatch(); }
    catch { this.watchRetry = setTimeout(() => { void this.restartWatch(watcher, true); }, TTL * 1000 / 3); this.watchRetry.unref?.(); }
  }
  campaign() {
    if (!this.checkLease()) throw notController();
    this.election = this.electionFactory(this.lease);
    const campaign = this.election.campaign(this.nodeId);
    this.candidate = campaign;
    campaign.on('error', () => { if (this.candidate === campaign) this.isolate('election-lost'); });
    campaign.on('elected', () => { void this.elected(campaign).catch(() => this.isolate('term-unconfirmed')); });
    return campaign;
  }
  async elected(campaign) {
    const key = await campaign.getCampaignKey();
    const { kvs } = await this.client.get(key).exec();
    if (this.candidate !== campaign || !this.checkLease()) return;
    const kv = kvs[0];
    if (!kv || kv.value.toString() !== this.nodeId || kv.lease !== await this.lease.grant()) throw notController();
    this.electionKey = key; this.ownTerm = kv.create_revision; this.controller = true;
    await this.confirm();
    this.record('elected', { nodeId: this.nodeId, term: this.ownTerm });
    this.emit('controller', this.ownTerm);
  }
  async confirm() {
    this.assertController();
    const result = await this.client.if(this.electionKey, 'Create', '==', this.ownTerm).then(this.client.get(this.electionKey)).commit();
    if (!result.succeeded) { this.isolate('stale-term'); throw notController(); }
    this.assertController();
  }
  async guardedPut(key, value) {
    this.assertController();
    const result = await this.client.if(this.electionKey, 'Create', '==', this.ownTerm)
      .then(this.client.put(key).value(typeof value === 'string' ? value : JSON.stringify(value))).commit();
    if (!result.succeeded) { this.isolate('stale-term'); throw notController(); }
    this.assertController();
  }
  async writeInfo() {
    return this.guardedPut('/codex/cluster/info', { members: this.members.size, term: this.term(), at: this.clock() });
  }
  async status() {
    const members = await Promise.all([...this.members.values()].map(async member => {
      const { TTL: remaining } = await this.client.leaseClient.leaseTimeToLive({ ID: member.leaseId });
      return { ...member, ttl: Math.max(0, Number(remaining)) };
    }));
    const nodeId = await this.election?.leader();
    const member = members.find(value => value.nodeId === nodeId);
    const key = member && `/codex/controller/${member.leaseId}`;
    const kv = key && (await this.client.get(key).exec()).kvs[0];
    const control = kv?.value.toString() === nodeId ? { nodeId, term: kv.create_revision } : null;
    if (JSON.stringify(control) !== JSON.stringify(this.observedControl)) {
      this.observedControl = control; this.record('control-observed', { control });
    }
    return { members, control, events: [...this.events] };
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.isolate('shutdown');
    clearTimeout(this.timer); clearTimeout(this.watchRetry);
    // Campaign.resign also revokes the shared lease. Explicit revoke is idempotent.
    try { await this.candidate?.resign(); }
    finally {
      try { await this.lease?.revoke(); }
      finally { try { await this.watcher?.cancel(); } finally { this.client.close(); } }
    }
  }
}
