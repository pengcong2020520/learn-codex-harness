import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplicationWorker,DEBOUNCE_MS,IDLE_SYNC_MS } from '../server/modules/replication/worker.mjs';
import { currentIdentity } from '../server/modules/accounts/context.mjs';
import { lagOf,LAG_MS,ReplicationStore } from '../server/modules/replication/store.mjs';
import { authorizeReplica } from '../server/modules/replication/index.mjs';
function fixture() {
 const calls=[],timers=new Map();let position,busy=0,hash='a',sendError=false;
 const route={primary:'node-a',replica:'node-b',epoch:1,shardId:'0'};
 const runtime={nodeId:'node-a',cache:{routeOf:()=>route,shards:{0:route}},owns:()=>true,coordination:{members:new Map([['node-b',{}]])}};
 const store={boundary:async()=>({busy,sequence:'2'}),users:async()=>['bob'],position:async()=>position,
 begin:async()=>calls.push('begin'),finish:async(u,r,s,h)=>{calls.push('position');position={content_hash:h,epoch:r.epoch,shard_id:r.shardId,last_task_sequence:s};}};
 const worker=new ReplicationWorker({runtime,store,log:()=>{},setTimer:(fn,ms)=>{assert.equal(ms,5000);const id={};timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id),
 quiesce:async()=>{assert.equal(currentIdentity().userId,'bob');calls.push('freeze');return true;},release:async()=>calls.push('release'),snapshot:async()=>({hash}),send:async()=>{calls.push('send');if(sendError)throw Error('offline');}});
 return {worker,calls,timers,setBusy:n=>busy=n,setHash:s=>hash=s,setError:v=>sendError=v,runtime};
}
test('轮次边界：执行中不复制，5 秒去抖，同用户合并，先传输后位点',async()=>{
 const f=fixture();assert.equal(DEBOUNCE_MS,5000);assert.equal(IDLE_SYNC_MS,60000);
 f.setBusy(1);assert.equal(await f.worker.sync('bob'),false);assert.deepEqual(f.calls,[]);f.setBusy(0);
 f.worker.schedule('bob');f.worker.schedule('bob');assert.equal(f.timers.size,1);
 const [timer]=f.timers.values();timer();await f.worker.pending.get('bob');
 assert.deepEqual(f.calls,['freeze','begin','send','position','release']);
 f.calls.length=0;await f.worker.sweep();assert.deepEqual(f.calls,['freeze','release'],'内容哈希一致跳过传输');
 f.setHash('b');f.calls.length=0;
 const a=f.worker.sync('bob'),b=f.worker.sync('bob');assert.equal(a,b);await a;assert.equal(f.calls.filter(c=>c==='send').length,1);await f.worker.close();
});
test('复制失败保留操作单，不推进位点，不使主节点隔离，重试成功清除错误',async()=>{
 const f=fixture();f.setError(true);await assert.rejects(f.worker.sync('bob'));assert.ok(f.worker.errors.has('bob'));assert.ok(!f.calls.includes('position'));assert.equal(f.calls.at(-1),'release');
 f.setError(false);await f.worker.sync('bob');assert.equal(f.worker.errors.size,0);await f.worker.close();
});
test('落后计算：以未复制完成轮次的最早完成时间计时，空闲已同步不误报',()=>{
 const now=1_000_000;
 assert.equal(lagOf({lag_rounds:0,pending_since:null},now).lag_seconds,0);
 assert.equal(lagOf({lag_rounds:2,pending_since:new Date(now-LAG_MS)},now).replica_lagging,false);
 assert.deepEqual(Object.fromEntries(Object.entries(lagOf({lag_rounds:'2',pending_since:new Date(now-LAG_MS-1000)},now)).filter(([k])=>k!=='pending_since')),{lag_rounds:2,lag_seconds:301,replica_lagging:true});
});
test('接收方：每节点认证之后仍核对当前主、目标、epoch、操作单和发布状态',async()=>{
 const row={node_id:'node-a',replica:'node-b',epoch:'7',token:'token'};
 const db={query:async()=>({rows:[row]})},args={userId:'bob',caller:'node-a',receiver:'node-b',epoch:7,token:'token'};
 await authorizeReplica(db,args);
 for(const patch of [{caller:'node-c'},{receiver:'node-c'},{epoch:6},{token:'old'}])await assert.rejects(authorizeReplica(db,{...args,...patch}),{code:'REPLICA_AUTH'});
 row.publishing=true;await assert.rejects(authorizeReplica(db,args),{code:'REPLICA_AUTH'});
});
test('接管恢复：生产 SQL 只标已完成尾部、执行中待核对，queued 只写 outbox',async()=>{
 const queries=[],db={query:async(sql,args)=>{queries.push([sql,args]);return {rows:[],rowCount:1};},release(){}};
 await new ReplicationStore({connect:async()=>db},'instance').recover('bob',8);
 assert.equal(queries[0][0],'BEGIN');assert.equal(queries.at(-1)[0],'COMMIT');
 const missing=queries.find(([q])=>q.includes("SET status='replica_missing'"));assert.match(missing[0],/t.status='completed'/);assert.match(missing[0],/t.sequence>coalesce/);assert.equal(missing[1][3],8);
 assert.ok(queries.some(([q])=>q.includes("SET status='unconfirmed'")&&q.includes("('starting','running','steering')")));
 assert.ok(queries.some(([q])=>q.includes('INSERT INTO agent_data.outbox')&&q.includes("t.status='queued'")));
 assert.ok(!queries.some(([q])=>q.includes("SET status='queued'")));
});

test('readiness：副本落后仍返回200，degraded列出分片',async()=>{
 const {createHttpService}=await import('../server/modules/http/index.mjs');
 const {EventEmitter}=await import('node:events');
 const config={root:'/tmp',deployment:{},sharding:{replication:{status:async()=>({shards:[{shardId:'0',replica_lagging:true},{shardId:'1',replica_lagging:false}]})}}};
 const http=createHttpService({config,sessions:{},hub:new EventEmitter(),redact:JSON.stringify,readiness:async()=>({status:'ready'})});
 const response={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
 await http.handle({method:'GET',url:'/ready',headers:{}},response);
 assert.equal(response.status,200);assert.deepEqual(response.body.degraded,{replica_lagging:['0']});
 await http.close();
});
test('轮次边界：冻结之后再检查执行中状态，防止检查/派发竞态',async()=>{
 const f=fixture();f.worker.quiesce=async()=>{f.setBusy(1);return true;};
 assert.equal(await f.worker.sync('bob'),false);assert.deepEqual(f.calls,['release']);await f.worker.close();
});
