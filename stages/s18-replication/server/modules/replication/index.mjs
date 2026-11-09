import { hasMember, takeoverReason } from './control.mjs';
import { businessQuery } from '../data/write.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwner, currentIdentity } from '../accounts/context.mjs';
import { RuntimeStore } from '../runtimes/store.mjs';
import { prepareDirectories } from '../runtimes/directories.mjs';
import { exportTree, importTree, transferPath } from '../sharding/transfer.mjs';
import { nodeHeaders, targetOf } from '../sharding/routing.mjs';
import { copyContent, receiveContent, contentFiles } from '../sharding/http.mjs';
import { transaction } from '../data/database.mjs';
import { AppError } from '../../../shared/errors.mjs';
import { ReplicationStore } from './store.mjs';
import { ReplicationWorker } from './worker.mjs';
const exec=promisify(execFile);
export async function directoryHash(root,record) {
  const hash=createHash('sha256');
  for(const kind of ['home','workspace']) {
    const identity=kind==='home'?{uid:record.uid,gid:record.uid}:{uid:process.getuid(),gid:process.getgid()};
    const {stdout}=await exec(process.execPath,[fileURLToPath(new URL('./hash-worker.mjs',import.meta.url)),transferPath(root,record,kind),kind],
      {...identity,cwd:'/',env:{PATH:'/usr/bin:/bin'},timeout:30000});
    hash.update(stdout);
  }
  return hash.digest('hex');
}
export async function authorizeReplica(db,{userId,caller,receiver,epoch,token}) {
  const row=(await businessQuery(db,`SELECT s.*,x.token FROM agent_data.user_shards u JOIN agent_data.shard_owners s USING(shard_id)
    JOIN agent_data.replication_transfers x ON x.user_id=u.user_id AND x.shard_id=u.shard_id AND x.epoch=s.epoch
    WHERE u.user_id=$1`,[userId])).rows[0];
  if(!row || row.node_id!==caller || row.replica!==receiver || String(row.epoch)!==String(epoch) || row.token!==token || row.recovering || row.publishing)
    throw new AppError('复制调用方、目标、epoch 或操作单不匹配。',403,'REPLICA_AUTH');
  return row;
}
export function attachReplication(app,runtime,control) {
  const store=new ReplicationStore(app.data.pool,app.data.scope.instanceId);
  const recordFor=async userId=>(await businessQuery(app.data.pool,'SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2',[app.data.scope.instanceId,userId])).rows[0];
  const controlCall=async (action,body)=>{
    if(runtime.coordination.isController()) return control[action](body.shardId,body.epoch,runtime.nodeId);
    const owner=await runtime.coordination.observeControl();
    return runtime.call(targetOf({primary:owner?.nodeId},runtime.coordination.members),'/internal/replication/'+action,body);
  };
  const worker=new ReplicationWorker({runtime,store,log:app.config.generation?.log,
    quiesce:async userId=>{
      if(runtime.paused.has(userId)) return false;
      runtime.paused.add(userId);held.add(userId);
      // atBoundary installs pool.withOwner and hub.withUser under the explicit runOwner scope.
      if(app.runtimes.pool.entries.has(userId)) await app.sessions.atBoundary(async()=>{});
      app.runtimes.pool.blocked.add(userId);
      await app.media?.waitOwner?.(userId);await app.runtimes.waitSkills?.(userId);await app.usage.pending;
      const entry=app.runtimes.pool.entries.get(userId);
      if((await store.boundary(userId)).busy || entry?.refs || runtime.inflight?.get(userId)) return false;
      if(entry) await app.runtimes.pool.remove(entry);
      return true;
    },
    release:async userId=>{if(held.delete(userId)){runtime.paused.delete(userId);app.runtimes.pool.blocked.delete(userId);}},
    snapshot:async userId=>{
      let record=await recordFor(userId);
      if(!record) record=await new RuntimeStore(app.data.pool,app.data.scope.instanceId,app.config.root).ensure(userId);
      prepareDirectories(app.config.root,record,{isolated:process.getuid()===0});
      const hash=createHash('sha256').update(await directoryHash(app.config.root,record)).update(JSON.stringify(await contentFiles(app,userId))).digest('hex');
      return {hash,record};
    },
    send:async(userId,route,token,{record})=>{
      const address=targetOf({primary:route.replica},runtime.coordination.members);
      for(const kind of ['home','workspace']) {
        app.config.generation?.assert();
        const archive=exportTree(app.config.root,record,kind);
        try {
          const query=new URLSearchParams({user:userId,kind,epoch:String(route.epoch),operationId:token});
          const response=await fetch(new URL('/internal/replication/tree?'+query,address),{method:'PUT',headers:nodeHeaders(runtime),body:archive.stream,duplex:'half',redirect:'error',signal:AbortSignal.timeout(30000)});
          await archive.done;if(!response.ok)throw new Error('从节点拒绝复制目录。');await response.arrayBuffer();
        }finally{await archive.stop();}
      }
      await copyContent(app,runtime,userId,address,token,'/internal/replication/content',route.epoch);
    }
  });
  const held=new Set();
  const patch=app.data.jobs.patch.bind(app.data.jobs);
  app.data.jobs.patch=async(...args)=>{
    const result=await patch(...args);
    if(result && ['completed','failed','interrupted','needs-review','cancelled'].includes(args[1]?.status)) {
      const owner=currentIdentity()?.userId;if(owner)worker.schedule(owner);
    }
    return result;
  };
  const stopShard=async shardId=>{
    for(const entry of [...app.runtimes.pool.entries.values()]) if(runtime.cache.routeOf(entry.owner).shardId===shardId) {
      runtime.paused.add(entry.owner);app.http.closeUserStreams?.(entry.owner);
      await runOwner(entry.owner,()=>app.runtimes.pool.remove(entry));
    }
  };
  app.config.generation.stopShard=stopShard;
  const received=new Map();
  const api={worker,store,stopShard,
    async receive(req,json,caller,kind) {
      const q=new URL(req.url,'http://localhost').searchParams,userId=q.get('user');
      const check=()=>{app.config.generation?.assert();return authorizeReplica(app.data.pool,{userId,caller,receiver:runtime.nodeId,epoch:q.get('epoch'),token:q.get('operationId')});};
      await check();
      if(received.has(userId))throw new AppError('副本正在导入。',409);
      const work=runOwner(userId,async()=>{
        const entry=app.runtimes.pool.entries.get(userId);
        if(entry)await app.runtimes.pool.remove(entry);
        const record=await recordFor(userId);if(!record)throw new AppError('运行环境映射缺失。',409);
        // Serializes filesystem publication with the CT001 switch transaction, including beforePublish.
        return transaction(app.data.pool,async db=>{
          await businessQuery(db,'SELECT s.shard_id FROM agent_data.shard_owners s JOIN agent_data.user_shards u USING(shard_id) WHERE u.user_id=$1 FOR SHARE OF s,u',[userId]);
          await check();
          if(kind==='content') return receiveContent(app,req,json,check);
          const result=await importTree(app.config.root,record,q.get('kind'),req,check);return json(200,result);
        });
      });
      received.set(userId,work);try{return await work;}finally{received.delete(userId);}
    },
    async finalSync(shardId,epoch) {
      const deadline=Date.now()+10*60*1000;
      for(const userId of await store.users(shardId)) {
        for(;;) {
          const row=(await businessQuery(app.data.pool,'SELECT * FROM agent_data.shard_owners WHERE shard_id=$1',[shardId])).rows[0];
          if(row.node_id!==runtime.nodeId || String(row.epoch)!==String(epoch) || !row.paused)throw new AppError('切换暂停或 epoch 已改变。',409);
          if(await worker.sync(userId,{force:true}))break;
          if(Date.now()>deadline)throw new AppError('等待轮次结束超时；分片保持暂停。',409);
          await delay(200);
        }
      }
      return {synced:true};
    },
    async tick() {
      if(api.pending)return api.pending;
      api.pending=(async()=>{
        const rows=await control.rows();
        for(const row of rows) {
          if(row.node_id!==runtime.nodeId) {await stopShard(row.shard_id);continue;}
          if(row.publishing)continue;
          if(row.recovering) {
            for(const userId of await store.users(row.shard_id)) await runOwner(userId,()=>store.recover(userId,row.epoch));
            await controlCall('recovered',{shardId:row.shard_id,epoch:row.epoch});
            for(const userId of await store.users(row.shard_id))runtime.paused.delete(userId);
          }
          if(row.replica && !row.replica_ready && hasMember(runtime.coordination.members,row.replica)) {
            let complete=true;
            for(const userId of await store.users(row.shard_id)) if(!await worker.sync(userId).catch(()=>false)) complete=false;
            if(complete)await controlCall('ready',{shardId:row.shard_id,epoch:row.epoch});
          }
        }
      })().finally(()=>{api.pending=null;});return api.pending;
    },
    async status(){
      const users=await store.status(),rows=await control.rows();
      return {users,shards:rows.map(row=>({shardId:row.shard_id,primary:row.node_id,replica:row.replica,epoch:Number(row.epoch),replica_ready:row.replica_ready,
        status:!hasMember(runtime.coordination.members,row.node_id)?'unavailable':row.recovering||row.publishing?'recovering':row.paused?'paused':'available',
        reason:control.reasons.get(row.shard_id)||(!hasMember(runtime.coordination.members,row.node_id)?takeoverReason(row,runtime.coordination.members,users.some(u=>u.shard_id===row.shard_id&&u.transfer_started_at))||'等待 control 接管':null),
        replica_lagging:!row.replica_ready||users.some(u=>u.shard_id===row.shard_id&&(u.replica_lagging||u.transfer_started_at)),
        users:users.filter(u=>u.shard_id===row.shard_id)})),errors:Object.fromEntries(worker.errors)};
    },
    async close(){await worker.close();await api.pending?.catch(()=>{});await Promise.allSettled(received.values());}
  };
  const close=app.close.bind(app);
  app.close=async()=>{await api.close();return close();};
  app.replication=api;worker.open();return api;
}
