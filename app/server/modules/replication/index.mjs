import { hasMember, takeoverReason } from './control.mjs';
import fs from 'node:fs';
import { businessQuery } from '../data/write.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwner, currentIdentity } from '../accounts/context.mjs';
import { RuntimeStore } from '../runtimes/store.mjs';
import { prepareDirectories } from '../runtimes/directories.mjs';
import { importTree, transferPath, transferLimit } from '../sharding/transfer.mjs';
import { nodeHeaders, targetOf } from '../sharding/routing.mjs';
import { copyContent, receiveContent, contentFiles } from '../sharding/http.mjs';
import { transaction } from '../data/database.mjs';
import { AppError } from '../../../shared/errors.mjs';
import { ReplicationStore } from './store.mjs';
import { ReplicaPublication } from './publication.mjs';
import { ReplicationWorker } from './worker.mjs';
import { ReplicationSpool } from './spool.mjs';
import { ReplicationRateLimiter, replicationRateLimit, sendArchive } from './transport.mjs';
const exec=promisify(execFile);
export function replicaHomeMissing(root, record) {
  if (!record) return true;
  try { fs.lstatSync(transferPath(root, record, 'home')); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
export async function directoryHash(root,record) {
  const hash=createHash('sha256');
  for(const kind of ['home','workspace']) {
    const identity=kind==='home'?{uid:record.uid,gid:record.uid}:{uid:process.getuid(),gid:process.getgid()};
    const {stdout}=await exec(process.execPath,[fileURLToPath(new URL('./hash-worker.mjs',import.meta.url)),transferPath(root,record,kind),kind,String(transferLimit())],
      {...identity,cwd:'/',env:{PATH:'/usr/bin:/bin'},timeout:30000}).catch(error=>{
        if(error.stderr?.includes('TRANSFER_TOO_LARGE'))throw new AppError('目录过大：复制内容超过接收上限。',413,'TRANSFER_TOO_LARGE');
        throw error;
      });
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
  const limiter=new ReplicationRateLimiter(app.config.replicationRateLimit ?? replicationRateLimit());
  const spool=new ReplicationSpool(app.config.root);
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
    snapshot:async (userId,token,unchanged)=>{
      let record=await recordFor(userId);
      if(!record) record=await new RuntimeStore(app.data.pool,app.data.scope.instanceId,app.config.root).ensure(userId);
      prepareDirectories(app.config.root,record,{isolated:process.getuid()===0});
      return spool.capture(record,token,async()=>{
        const files=await contentFiles(app,userId);
        const hash=createHash('sha256').update(await directoryHash(app.config.root,record)).update(JSON.stringify(files)).digest('hex');
        return {hash,files};
      },unchanged);
    },
    send:async(userId,route,token,{archives,files},signal)=>{
      const address=targetOf({primary:route.replica},runtime.coordination.members);
      for(const kind of ['home','workspace']) {
        app.config.generation?.assert();
        const query=new URLSearchParams({user:userId,kind,epoch:String(route.epoch),operationId:token});
        await sendArchive(new URL('/internal/replication/tree?'+query,address),archives[kind],{headers:nodeHeaders(runtime),limiter,signal});
      }
      await copyContent(app,runtime,userId,address,token,'/internal/replication/content',route.epoch,files);
      const body={userId,epoch:route.epoch,token,files};
      try { await runtime.call(address,'/internal/replication/publish',body); }
      catch (error) {
        // A lost acknowledgement may hide a completed pair of renames. PG has not advanced.
        await runtime.call(address,'/internal/replication/settle',body).catch(()=>{});throw error;
      }
      return {settle:()=>runtime.call(address,'/internal/replication/settle',body)};
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
  const publicationFor=async userId=>new ReplicaPublication(app.config.root,userId,await recordFor(userId),app.config.generation?.log);
  const exclusive=async(userId,operation)=>{
    if(received.has(userId))throw new AppError('副本正在导入。',409);
    const work=runOwner(userId,operation);received.set(userId,work);
    try{return await work;}finally{received.delete(userId);}
  };
  const api={worker,store,stopShard,
    async publish({userId,epoch,token,files},caller) {
      return exclusive(userId,()=>transaction(app.data.pool,async db=>{
        await businessQuery(db,'SELECT s.shard_id FROM agent_data.shard_owners s JOIN agent_data.user_shards u USING(shard_id) WHERE u.user_id=$1 FOR SHARE OF s,u',[userId]);
        app.config.generation?.assert();await authorizeReplica(db,{userId,epoch,token,caller,receiver:runtime.nodeId});
        const publication=await publicationFor(userId);
        if(publication.batch?.token!==token)throw new AppError('复制暂存操作不匹配。',409);
        // New turns may add files after this boundary. Authorize the captured subset,
        // never require newer content to be present in an older snapshot.
        const allowed=await contentFiles(app,userId);
        if(!Array.isArray(files) || !files.every(file=>allowed.some(entry=>entry.file===file.file && entry.kind===file.kind && entry.digest===file.digest)))
          throw new AppError('复制内容清单未授权。',403);
        publication.publish(files);return {published:true};
      }));
    },
    async settle({userId,epoch,token},caller) {
      return exclusive(userId,()=>transaction(app.data.pool,async db=>{
        const row=(await businessQuery(db,'SELECT s.* FROM agent_data.shard_owners s JOIN agent_data.user_shards u USING(shard_id) WHERE u.user_id=$1 FOR SHARE OF s,u',[userId])).rows[0];
        if(row?.node_id!==caller || row.replica!==runtime.nodeId || String(row.epoch)!==String(epoch))throw new AppError('复制确认归属已改变。',403);
        // Wait for an ambiguous COMMIT before deciding whether to restore the old pair.
        await businessQuery(db,'SELECT token FROM agent_data.replication_transfers WHERE user_id=$1 FOR UPDATE',[userId]);
        const position=(await businessQuery(db,'SELECT transfer_token FROM agent_data.replication_positions WHERE user_id=$1',[userId])).rows[0];
        const publication=await publicationFor(userId);
        if(publication.batch?.token===token)await publication.settle(position?.transfer_token===token);
        return {settled:true};
      }));
    },
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
          const publication=await publicationFor(userId),token=q.get('operationId');
          if(publication.batch && publication.batch.token!==token)await publication.settle((await store.position(userId))?.transfer_token===publication.batch.token);
          if(!publication.batch)publication.start(token);
          const result=kind==='content' ? await receiveContent(app,req,json,check,{stageOnly:true}) :
            await importTree(app.config.root,record,q.get('kind'),req,check,{stageOnly:true});
          publication.add(result);return {staged:true};
        });
      });
      received.set(userId,work);try{return json(200,await work);}finally{received.delete(userId);}
    },
    async finalSync(shardId,epoch) {
      const deadline=Date.now()+10*60*1000;
      for(const userId of await store.users(shardId)) {
        for(;;) {
          const row=(await businessQuery(app.data.pool,'SELECT * FROM agent_data.shard_owners WHERE shard_id=$1',[shardId])).rows[0];
          if(row.node_id!==runtime.nodeId || String(row.epoch)!==String(epoch) || !row.paused)throw new AppError('切换暂停或 epoch 已改变。',409);
          // An in-flight copy may predate the shard pause and miss a newer boundary.
          await worker.pending.get(userId)?.catch(()=>{});
          if(await worker.sync(userId,{force:true}))break;
          if(Date.now()>deadline)throw new AppError('等待轮次结束超时；分片保持暂停。',409);
          await delay(200);
        }
      }
      return {synced:true};
    },
    async tick() {
      if (runtime.nodes?.length === 1) return;
      if(api.pending)return api.pending;
      api.pending=(async()=>{
        const rows=await control.rows();
        for(const row of rows) {
          if(row.node_id!==runtime.nodeId) {await stopShard(row.shard_id);continue;}
          if(row.publishing)continue;
          if(row.recovering) {
            for(const userId of await store.users(row.shard_id)) await runOwner(userId,async()=>{
              const publication=await publicationFor(userId);
              if(publication.batch)await publication.settle((await store.position(userId))?.transfer_token===publication.batch.token);
              const missingHome=replicaHomeMissing(app.config.root,await recordFor(userId));
              await store.recover(userId,row.epoch,{missingHome});
              app.sessions.invalidateOwner(userId);
            });
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
      return {replication: runtime.nodes?.length === 1 ? 'off' : 'on',users,shards:rows.map(row=>({shardId:row.shard_id,primary:row.node_id,replica:row.replica,epoch:Number(row.epoch),replica_ready:row.replica_ready&&!users.some(u=>u.shard_id===row.shard_id&&(u.transfer_started_at||u.replication_error)),
        status:!hasMember(runtime.coordination.members,row.node_id)?'unavailable':row.recovering||row.publishing?'recovering':row.paused?'paused':'available',
        reason:users.find(u=>u.shard_id===row.shard_id&&u.replication_error)?.replication_error||control.reasons.get(row.shard_id)||(!hasMember(runtime.coordination.members,row.node_id)?takeoverReason(row,runtime.coordination.members,users.some(u=>u.shard_id===row.shard_id&&u.transfer_started_at))||'等待 control 接管':null),
        replica_lagging:runtime.nodes?.length === 1 ? false : !row.replica_ready||users.some(u=>u.shard_id===row.shard_id&&(u.replica_lagging||u.transfer_started_at)),
        users:users.filter(u=>u.shard_id===row.shard_id)})),errors:Object.fromEntries(worker.errors)};
    },
    async close(){await worker.close();await api.pending?.catch(()=>{});await Promise.allSettled(received.values());}
  };
  const close=app.close.bind(app);
  app.close=async()=>{await api.close();return close();};
  app.replication=api;worker.open();return api;
}
