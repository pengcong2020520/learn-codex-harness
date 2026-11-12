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
    this.dirty=new Set(); this.targets=new Map(); this.shutdown=new AbortController();
  }
  schedule(userId) {
    if(this.closed || this.runtime.nodes?.length === 1) return;
    if(this.pending.has(userId)) {this.dirty.add(userId);return;}
    this.clearTimer(this.timers.get(userId));
    const timer=this.setTimer(()=>{this.timers.delete(userId);void this.sync(userId).catch(()=>{});},DEBOUNCE_MS);
    timer.unref?.();this.timers.set(userId,timer);
  }
  sync(userId, {force=false}={}) {
    if(this.closed || this.runtime.nodes?.length === 1) return Promise.resolve(false);
    if(this.pending.has(userId)) {this.dirty.add(userId);return this.pending.get(userId);}
    this.clearTimer(this.timers.get(userId));this.timers.delete(userId);
    const work=runOwner(userId,()=>withShardUser(userId,()=>this.copy(userId,force))).catch(error=>{
      this.errors.set(userId,{message:error.message,at:Date.now()});this.log(`副本落后 user=${userId}: ${error.message}`);throw error;
    }).finally(()=>{
      this.pending.delete(userId);
      if(this.dirty.delete(userId))this.schedule(userId);
    });
    this.pending.set(userId,work);return work;
  }
  async forTarget(target, operation) {
    const previous=this.targets.get(target) || Promise.resolve();
    const work=previous.catch(()=>{}).then(()=>{this.shutdown.signal.throwIfAborted();return operation();});
    this.targets.set(target,work);
    try {return await work;} finally {if(this.targets.get(target)===work)this.targets.delete(target);}
  }
  async copy(userId,force) {
    const route=this.runtime.cache.routeOf(userId);
    if(!this.runtime.owns(userId) || !route.replica || !hasMember(this.runtime.coordination.members,route.replica)) return false;
    if((await this.store.boundary(userId)).busy) return false;
    let snapshot, receipt, begun=false, released=false;
    const token=randomUUID();
    try {
      // Close admission BEFORE checking again; quiesce waits for admission already in flight.
      if(!await this.quiesce(userId)) return false;
      const boundary=await this.store.boundary(userId);
      if(boundary.busy) return false;
      const previous=await this.store.position(userId), unfinished=await this.store.unfinished(userId);
      const unchanged=hash=>!force && !unfinished && previous?.content_hash===hash && String(previous.epoch)===String(route.epoch) && previous.shard_id===route.shardId && String(previous.last_task_sequence)===String(boundary.sequence);
      // Hash first: an unchanged idle user must not be re-exported to the spool every sweep.
      snapshot=await this.snapshot(userId,token,unchanged);
      // No network or destination queue wait holds user admission closed.
      await this.release(userId);released=true;
      if(snapshot.unchanged || unchanged(snapshot.hash)) return true;
      return await this.forTarget(route.replica,async()=>{
        await this.store.begin(userId,route,token);begun=true;
        receipt=await this.send(userId,route,token,snapshot,this.shutdown.signal);
        // Commit the captured boundary, even if newer turns finished while sending.
        try { await this.store.finish(userId,route,boundary.sequence,snapshot.hash,token,boundary.captured_at); }
        finally { await receipt?.settle(); }
        this.errors.delete(userId);return true;
      });
    } catch (error) {
      if (!begun) await this.store.begin(userId,route,token).catch(()=>{});
      await this.store.fail?.(userId,error).catch(()=>{});
      throw error;
    } finally {
      try {if(!released)await this.release(userId);} finally {await snapshot?.close?.();}
    }
  }
  async sweep() {
    for(const [id,owner] of Object.entries(this.runtime.cache.shards)) if(owner.primary===this.runtime.nodeId)
      for(const userId of await this.store.users(id)) await this.sync(userId).catch(()=>{});
  }
  open() { if(this.runtime.nodes?.length === 1) return this; this.timer=setInterval(()=>{void this.sweep().catch(this.log);},IDLE_SYNC_MS);this.timer.unref();return this; }
  async close() {this.closed=true;this.shutdown.abort(new Error('复制服务关闭。'));clearInterval(this.timer);for(const timer of this.timers.values())this.clearTimer(timer);await Promise.allSettled(this.pending.values());}
}
