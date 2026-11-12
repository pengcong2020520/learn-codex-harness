import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplicationControl,ring,takeoverReason } from '../server/modules/replication/control.mjs';
import { Coordination } from '../server/modules/coordination/index.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { FakeClient } from './fixtures/coordination-client.mjs';
import { shardFailure } from '../server/modules/sharding/fence.mjs';
import { runCluster } from '../client/cluster.mjs';
async function fixture(t) {
 const client=new FakeClient();client.set('/codex/controller/test','node-c');
 const c={client,nodeId:'node-c',members:new Map([['node-b',{nodeId:'node-b'}],['node-c',{nodeId:'node-c'}]]),electionKey:'/codex/controller/test',ownTerm:'1',term:()=> '1',assertController(){},confirm:async()=>{}};
 const cache=await new RouteCache(client).open();t.after(()=>cache.close());
 const instance=randomUUID();
 const queries=[];
 const events=[],row={shard_id:'0',node_id:'node-a',replica:'node-b',epoch:'1',replica_ready:true,publishing:false,recovering:false,paused:false};let transfer=false;
 const db={release(){},query:async(q,args)=>{
  queries.push([q,args]);
  if(q==='COMMIT'||q==='BEGIN'||q==='ROLLBACK'){events.push(q);return {rows:[]};}
  if(q.startsWith('SELECT * FROM agent_data.shard_owners'))return {rows:[{...row}]};
  if(q.includes('LEFT JOIN agent_data.replication_positions')){assert.equal(args[0],'0');assert.equal(String(args[1]),row.epoch);assert.equal(args[2],instance);return {rowCount:transfer?1:0,rows:[]};}
  if(q.includes('previous_primary=node_id')){Object.assign(row,{previous_primary:row.node_id,node_id:row.replica,replica:null,epoch:String(Number(row.epoch)+1),replica_ready:false,publishing:true,recovering:true,paused:false});events.push('switch');}
  if(q.includes('SET publishing=false'))row.publishing=false;
  if(q.includes('SET paused=true'))row.paused=true;
  if(q.includes('SET recovering=false'))row.recovering=false;
  if(q.includes('SET replica=previous_primary')){row.replica=row.previous_primary;row.replica_ready=false;row.publishing=true;}
  if(q.includes('SET replica_ready=true'))row.replica_ready=true;
  return {rows:[],rowCount:1};
 }};
 c.guardedPut=async(...args)=>{events.push('etcd');return Coordination.prototype.guardedPut.apply(c,args);};
 const ctl=new ReplicationControl(c,cache,{connect:async()=>db,query:db.query},instance, ['node-a','node-b','node-c']);ctl.log=()=>{};
 return {ctl,row,events,c,cache,queries,instance,setTransfer:v=>transfer=v};
}
test('副本放置：0 a→b / 1 b→c / 2 c→a；不可用原因区分离线与未追平',()=>{
 assert.deepEqual(['0','1','2'].map(id => ring(id, ['node-a','node-b','node-c'])),[{primary:'node-a',replica:'node-b',epoch:1},{primary:'node-b',replica:'node-c',epoch:1},{primary:'node-c',replica:'node-a',epoch:1}]);
 assert.match(takeoverReason({replica:'node-b'},new Map()),/不在线/);
 assert.match(takeoverReason({replica:'node-b',replica_ready:false},new Map([['node-b',{}]])),/未追平/);
});
test('自动接管：先 PG COMMIT 后生产 guardedPut，RouteCache 解析相同协议',async t=>{
 const f=await fixture(t);await f.ctl.switch('0');assert.equal(f.row.node_id,'node-b');assert.equal(f.row.replica,null);assert.equal(f.row.epoch,'2');assert.equal(f.row.replica_ready,false);assert.equal(f.row.recovering,true);
 assert.ok(f.events.indexOf('COMMIT')<f.events.indexOf('etcd'));
 assert.deepEqual(f.cache.shards['0'],{primary:'node-b',replica:null,epoch:2});
});
test('接管门禁：未追平、离线、半份目录均不能切换',async t=>{
 const f=await fixture(t);f.row.replica_ready=false;await assert.rejects(f.ctl.switch('0'),{code:'REPLICA_UNAVAILABLE'});f.row.replica_ready=true;
 f.setTransfer(true);await assert.rejects(f.ctl.switch('0'),{code:'REPLICA_UNAVAILABLE'});f.setTransfer(false);
 f.c.members.delete('node-b');await assert.rejects(f.ctl.switch('0'),{code:'REPLICA_UNAVAILABLE'});assert.equal(f.row.epoch,'1');
});
test('etcd 写失败：PG 新 epoch 保留 publishing=true；对账发布后才解除',async t=>{
 const f=await fixture(t),put=f.c.guardedPut;f.c.guardedPut=async()=>{throw Error('etcd unavailable');};
 await assert.rejects(f.ctl.switch('0'));assert.equal(f.row.epoch,'2');assert.equal(f.row.publishing,true);
 f.c.guardedPut=put;await f.ctl.publish();assert.equal(f.row.publishing,false);assert.equal(f.cache.shards['0'].epoch,2);
});
test('手动切换：持久化暂停→等待最后同步→切换，不自动切回；失败保持暂停可重试',async t=>{
 const f=await fixture(t);f.c.members.set('node-a',{});
 await assert.rejects(f.ctl.promote('0',async()=>{assert.equal(f.row.paused,true);throw Error('copy failed');}));assert.equal(f.row.node_id,'node-a');assert.equal(f.row.paused,true);
 await f.ctl.promote('0',async()=>{assert.equal(f.row.paused,true);});assert.equal(f.row.node_id,'node-b');assert.equal(f.row.replica,null);assert.equal(f.row.replica_ready,false);assert.equal(f.row.previous_primary,'node-a');
 let request;await runCluster(['promote','0'],{request:(...args)=>request=args});assert.equal(request[0],'/cluster/promote');assert.deepEqual(request[1],{shardId:'0'});
});
test('旧主 SH001：刷新后只停止失去归属的分片用户，不隔离整个节点',async()=>{
 let moved=false;const stopped=[],isolated=[];
 const g={nodeId:'node-a',routes:{routeOf:()=>({primary:moved?'node-b':'node-a',shardId:'0'}),refresh:async()=>{moved=true;}},stopShard:async id=>stopped.push(id),isolate:r=>isolated.push(r),log:()=>{}};
 await shardFailure({code:'SH001',detail:JSON.stringify({ownerId:'bob'})},g,new Error(),'UPDATE');assert.deepEqual(stopped,['0']);assert.deepEqual(isolated,[]);
});

test('旧主回归：只设为未就绪 replica，全部位点完成前不允许 ready',async t=>{
 const f=await fixture(t);await f.ctl.switch('0');await f.ctl.recovered('0',2,'node-b');
 f.c.members.set('/codex/members/node-a',{nodeId:'node-a'});
 await f.ctl.place();assert.equal(f.row.node_id,'node-b');assert.equal(f.row.replica,'node-a');assert.equal(f.row.replica_ready,false);
 f.setTransfer(true);assert.deepEqual(await f.ctl.ready('0',2,'node-b'),{ready:false});assert.equal(f.row.replica_ready,false);
 f.setTransfer(false);assert.deepEqual(await f.ctl.ready('0',2,'node-b'),{ready:true});assert.equal(f.row.replica_ready,true);
 await assert.rejects(f.ctl.ready('0',1,'node-b'));await assert.rejects(f.ctl.ready('0',2,'node-a'));
});

test('实例范围为必填；放置、ready 与接管使用同一实例和当前分片 epoch',async t=>{
 assert.throws(()=>new ReplicationControl({}, {}, {}),/instanceId/);
 const f=await fixture(t);f.c.members.set('node-a',{nodeId:'node-a'});
 await f.ctl.place();
 const census=f.queries.find(([q])=>q.startsWith('SELECT id FROM agent_data.users'));
 assert.match(census[0],/WHERE instance_id=\$1 AND/);assert.deepEqual(census[1],[f.instance]);
 // The fake reports one uncopied account; neither entry point may bypass that census.
 f.row.replica_ready=false;f.setTransfer(true);
 assert.deepEqual(await f.ctl.ready('0',1,'node-a'),{ready:false});assert.equal(f.row.replica_ready,false);
 f.row.replica_ready=true;f.c.members.delete('node-a');
 await assert.rejects(f.ctl.switch('0'),{code:'REPLICA_UNAVAILABLE'});
 const checks=f.queries.filter(([q])=>q.includes('LEFT JOIN agent_data.replication_positions'));
 assert.ok(checks.length>=2);
 for(const [q,args] of checks){
  assert.deepEqual(args.map(String),['0','1',f.instance]);
  assert.match(q,/u.shard_id=\$1 AND a.instance_id=\$3 AND a.username IS NOT NULL/);
  for(const alias of ['p','x']){
   assert.ok(q.includes(`${alias}.shard_id=u.shard_id AND ${alias}.epoch=$2`));
  }
 }
});
