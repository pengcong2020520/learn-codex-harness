import { hasMember } from './control.mjs';
import { randomUUID } from 'node:crypto';
import { withShardUser } from '../sharding/fence.mjs';
import { runOwner } from '../accounts/context.mjs';
export const DEBOUNCE_MS = 5000;
export const IDLE_SYNC_MS = 60000;
// Inject only IO boundaries; tests and production share scheduling, merging and position logic.
export class ReplicationWorker {
  constructor({ runtime, store, snapshot, send, quiesce, release, log = console.warn, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this,{runtime,store,snapshot,send,quiesce,release,log,setTimer,clearTimer});
    this.timers=new Map(); this.pending=new Map(); this.errors=new Map();
  }
  schedule(userId) {
    if(this.closed) return;
    this.clearTimer(this.timers.get(userId));
    const timer=this.setTimer(()=>{this.timers.delete(userId);void this.sync(userId).catch(()=>{});},DEBOUNCE_MS);
    timer.unref?.();this.timers.set(userId,timer);
  }
  sync(userId, {force=false}={}) {
    if(this.closed) return Promise.resolve(false);
    if(this.pending.has(userId)) return this.pending.get(userId);
    const work=runOwner(userId,()=>withShardUser(userId,()=>this.copy(userId,force))).catch(error=>{
      this.errors.set(userId,{message:error.message,at:Date.now()});this.log(`副本落后 user=${userId}: ${error.message}`);throw error;
    }).finally(()=>this.pending.delete(userId));
    this.pending.set(userId,work);return work;
  }
  async copy(userId,force) {
    const route=this.runtime.cache.routeOf(userId);
    if(!this.runtime.owns(userId) || !route.replica || !hasMember(this.runtime.coordination.members,route.replica)) return false;
    if((await this.store.boundary(userId)).busy) return false;
    let snapshot;
    try {
      // Close admission BEFORE checking again; quiesce waits for admission already in flight.
      if(!await this.quiesce(userId)) return false;
      const boundary=await this.store.boundary(userId);
      if(boundary.busy) return false;
      snapshot=await this.snapshot(userId);
      const previous=await this.store.position(userId);
      if(!force && previous?.content_hash===snapshot.hash && String(previous.epoch)===String(route.epoch) && previous.shard_id===route.shardId && String(previous.last_task_sequence)===String(boundary.sequence)) return true;
      const token=randomUUID();
      await this.store.begin(userId,route,token);
      await this.send(userId,route,token,snapshot);
      // Both trees and auxiliary content must be acknowledged before SH001-fenced progress is committed.
      await this.store.finish(userId,route,boundary.sequence,snapshot.hash,token);
      this.errors.delete(userId);return true;
    } finally { await snapshot?.close?.(); await this.release(userId); }
  }
  async sweep() {
    for(const [id,owner] of Object.entries(this.runtime.cache.shards)) if(owner.primary===this.runtime.nodeId)
      for(const userId of await this.store.users(id)) await this.sync(userId).catch(()=>{});
  }
  open() { this.timer=setInterval(()=>{void this.sweep().catch(this.log);},IDLE_SYNC_MS);this.timer.unref();return this; }
  async close() {this.closed=true;clearInterval(this.timer);for(const timer of this.timers.values())this.clearTimer(timer);await Promise.allSettled(this.pending.values());}
}
