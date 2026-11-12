import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { strategies, slotOf, defaultSlots } from '../server/modules/sharding/strategy.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { ShardControl } from '../server/modules/sharding/control.mjs';
import { ShardedService } from '../server/modules/sharding/service.mjs';
import { ShardRuntime } from '../server/modules/sharding/runtime.mjs';
import { routedRequest, staleRoute, validateRoute, forwardHttp, streamResponse, authenticateNode } from '../server/modules/sharding/routing.mjs';
import { shardFailure } from '../server/modules/sharding/fence.mjs';
import { fencePool } from '../server/modules/data/write.mjs';
import { moveUser } from '../server/modules/sharding/move.mjs';
import { attachKnowledge } from '../server/modules/sharding/knowledge.mjs';
import { runIdentity, runOwner } from '../server/modules/accounts/context.mjs';
import { validateTarListing } from '../server/modules/sharding/transfer.mjs';
import { shardStatus } from '../server/modules/sharding/http.mjs';
import { FakeClient, flush } from './fixtures/coordination-client.mjs';
const user = 'aa000000-0000-4000-8000-000000000001';
const members = new Map(['a','b','c'].map(s => [s,{nodeId:`node-${s}`,address:`http://node-${s}:434${s.charCodeAt(0)-97}`} ]));
async function cache(t) {
  const client = new FakeClient(); client.set('/codex/slots', JSON.stringify(defaultSlots()));
  for (let n=0;n<3;n++) client.set('/codex/shards/'+n, JSON.stringify({primary:`node-${'abc'[n]}`,epoch:1}));
  const c = await new RouteCache(client).open(); t.after(()=>c.close()); return {client,c};
}
test('strategy: stable SHA256 slots, 64 slots and hexadecimal ranges', () => {
  const map = {slots:defaultSlots()};
  assert.equal(Object.keys(map.slots).length,64);
  assert.equal(slotOf(user),slotOf(user)); assert.equal(slotOf(user),4);
  assert.deepEqual(['00','54','55','a9','aa','ff'].map(p=>strategies.range.shardOf(p+'0000',map)),['0','0','1','1','2','2']);
  assert.throws(()=>strategies.range.shardOf('zz'));
  const all = new Set(Array.from({length:300},(_,n)=>strategies.slots.shardOf(n.toString(16).padStart(32,'0'),map)));
  assert.equal(all.size,3);
});
test('strategy: overrides have priority over both strategies', async t => {
  const {client,c}=await cache(t); client.set('/codex/overrides/'+user,'"1"');
  assert.equal(c.routeOf(user).shardId,'1'); c.strategy=strategies.range; assert.equal(c.routeOf(user).shardId,'1');
  client.remove('/codex/overrides/'+user); assert.equal(c.routeOf(user).shardId,'2');
});
test('cache: snapshot revision, Watch, disconnect and compaction reread', async t => {
  const {client,c}=await cache(t); const first=c.revision;
  client.set('/codex/shards/0',JSON.stringify({primary:'node-b',epoch:2}));
  assert.ok(BigInt(c.revision)>BigInt(first)); assert.equal(c.shards[0].epoch,2);
  c.watcher.disconnect(); client.set('/codex/overrides/'+user,'"2"'); await flush();await flush();
  assert.equal(c.routeOf(user).shardId,'2');
  c.watcher.emit('error',new Error('required revision has been compacted')); await flush();await flush();
  assert.ok(client.operations.filter(x=>x[0]==='snapshot').length>=3);
});
test('cache: in-flight snapshot replays newer Watch suffix without revision regression',async t=>{
  const {client,c}=await cache(t); const snapshot=await client.getAll().prefix('/codex/').exec();
  let resolve; client.getAll=()=>({prefix:()=>({exec:()=>new Promise(r=>{resolve=r;})})});
  const refreshing=c.refresh(); client.set('/codex/overrides/'+user,'"1"'); const rev=c.revision;
  resolve(snapshot); await refreshing; assert.equal(c.routeOf(user).shardId,'1'); assert.equal(c.revision,rev);
});
test('route: STALE_ROUTE refreshes and retries exactly once; checks primary and revision',async()=>{
  let refresh=0,attempts=0;const cache={revision:'9',routeOf:()=>({primary:'node-b',shardId:'1',revision:'9'}),refresh:async()=>{refresh++;}};
  const options={cache,userId:user,nodeId:'node-a',members,local:()=>assert.fail(),remote:async()=>{attempts++;throw staleRoute();}};
  await assert.rejects(routedRequest(options),{code:'STALE_ROUTE'});assert.equal(refresh,1);assert.equal(attempts,2);
  attempts=0;refresh=0;options.remote=async()=>{if(++attempts===1)throw staleRoute();return 'ok';};
  assert.equal(await routedRequest(options),'ok');assert.equal(refresh,1);
  assert.throws(()=>validateRoute(cache,user,'node-a','8'),{code:'STALE_ROUTE'});
  assert.throws(()=>validateRoute(cache,user,'node-b','10'),{code:'STALE_ROUTE'});
  validateRoute(cache,user,'node-b','9');
});
test('route: unavailable shard returns 503 with reason and never retries another node',async()=>{
  let refreshed=0;
  await assert.rejects(routedRequest({cache:{routeOf:()=>({primary:'node-c',shardId:'2'}),refresh:()=>refreshed++},userId:user,nodeId:'node-a',members:new Map([['a',members.get('a')]]),local:()=>assert.fail(),remote:()=>assert.fail()}), e=>e.status===503&&e.code==='SHARD_UNAVAILABLE'&&e.message.includes('node-c'));
  assert.equal(refreshed,0);
});
test('route: SSE carries Last-Event-ID, node key and revision, streams unchanged with no deadline',async()=>{
  const route={revision:'9223372036854775806'}; let options;
  const upstream=await forwardHttp({method:'GET',url:'/events?threadId=t',headers:{'last-event-id':'primary:17',authorization:'Bearer token','x-node-key':'spoof'}},'http://node-b:4341',route,user,{nodeId:'node-a',key:'k'.repeat(32)},null,{fetcher:async(url,opt)=>{options=opt;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('id: primary:18\ndata: {}\n\n'));c.close();}}),{headers:{'content-type':'text/event-stream'}});}});
  assert.equal(options.signal,undefined);assert.equal(options.headers['last-event-id'],'primary:17');assert.equal(options.headers['x-route-revision'],route.revision);assert.equal(options.headers['x-node-key'],'k'.repeat(32));
  let text='';const out=new Writable({write(c,e,done){text+=c;done();}});out.writeHead=(status,headers)=>{assert.equal(status,200);assert.match(headers['content-type'],/event-stream/);};
  await streamResponse(upstream,out);assert.equal(text,'id: primary:18\ndata: {}\n\n');
  await forwardHttp({method:'POST',url:'/messages',headers:{}},'http://node-b',route,user,{nodeId:'node-a',key:'k'.repeat(32)},Buffer.from('{}'),{fetcher:async(url,opt)=>{assert.ok(opt.signal instanceof AbortSignal);assert.equal(opt.redirect,'error');return new Response('{}');}});
  assert.throws(()=>authenticateNode({'x-node-key':'bad'},'k'.repeat(32)),{code:'NODE_AUTH'});
});
test('fence: SH001 refreshes before isolation; a moved user does not isolate a healthy former primary',async()=>{
  const calls=[];const g={nodeId:'node-a',routes:{refresh:async()=>calls.push('refresh'),routeOf:()=>({primary:'node-a'})},isolate:()=>calls.push('isolate'),log:()=>calls.push('log')};
  await runOwner(user,()=>shardFailure({code:'SH001',detail:JSON.stringify({ownerId:user})},g,new Error(),'UPDATE'));
  assert.deepEqual(calls,['refresh','log','isolate']);calls.length=0;g.routes.routeOf=()=>({primary:'node-b'});
  await runOwner(user,()=>shardFailure({code:'SH001',detail:JSON.stringify({ownerId:user})},g,new Error(),'UPDATE'));assert.deepEqual(calls,['refresh','log']);
});
test('fence: business transactions SET LOCAL node and shard epoch, no control term required',async()=>{
  const calls=[];const client={query:async(...args)=>{calls.push(args);return {rows:[]};},release(){}};
  const g={nodeId:'node-b',routes:{routeOf:()=>({primary:'node-b',epoch:7})},assert(){}};
  const pool=fencePool({connect:async()=>client},g);
  await runOwner(user,()=>pool.query('UPDATE agent_data.tasks SET status=\'failed\''));
  assert.deepEqual(calls[1],["SELECT set_config('app.node',$1,true),set_config('app.shard_epoch',$2,true)",['node-b','7']]);assert.equal(calls.at(-1)[0],'COMMIT');
});
test('control: only control places unowned shards, synchronizes SQL and never fails over departed primaries',async t=>{
  const {client,c}=await cache(t); const writes=[];
  const coordination={members,isController:()=>true,assertController(){},term:()=> '10',confirm:async()=>{},guardedPut:async(k,v)=>{writes.push(k);client.set(k,typeof v === 'string' ? v : JSON.stringify(v));}};
  const sql=[];const db={query:async(q,args)=>{sql.push([q,args]);return {rows:[]};},release(){}};const ctl=new ShardControl(coordination,c,{connect:async()=>db});
  coordination.members=new Map([['b',members.get('b')]]);await ctl.reconcile();assert.equal(c.shards[0].primary,'node-a');assert.equal(writes.length,0);
  client.set('/codex/shards/0',JSON.stringify({primary:null,epoch:0}));coordination.members=members;await ctl.reconcile();assert.equal(c.shards[0].primary,'node-a');assert.ok(sql.some(([q])=>q.includes('advance_cluster_term')));
  coordination.assertController=()=>{throw Object.assign(new Error(),{code:'NOT_CONTROLLER'});};await assert.rejects(ctl.reconcile(),{code:'NOT_CONTROLLER'});
});
function moveFixture(failAt) {
  const steps=[];let shard='0';const cache={routeOf:()=>({primary:'node-a',shardId:shard}),shards:{'1':{primary:'node-b'}}};
  const step=async name=>{steps.push(name);if(name===failAt)throw new Error('injected '+name);};
  const op={id:user,user_id:user,from_shard:'0',to_shard:'1',source_node:'node-a',target_node:'node-b'};
  const options={userId:user,shardId:'1',cache,control:{isPaused:async()=>false,beginMove:async()=>{await step('pause-db');return op;},advanceMove:async(id,from,to)=>step(to),finishMove:()=>step('resume-db'),failMove:()=>step('failed-paused'),switchUser:async(u,s)=>{await step('switch-'+s);shard=s;}},pause:()=>step('pause-source'),drain:()=>step('drain'),copy:()=>step('copy'),resume:node=>step('resume-'+node)};
  return {steps,options,shard:()=>shard};
}
test('move: operation transitions bracket copy and switch; any uncertain failure remains paused',async()=>{
  const f=moveFixture();await moveUser(f.options);assert.deepEqual(f.steps,['pause-db','pause-source','drain','copying','copy','copied','switch-1','resume-node-b','resume-node-a','resume-db']);
  for (const failure of ['copy','switch-1','resume-node-b']) {
    const f=moveFixture(failure);await assert.rejects(moveUser(f.options));assert.equal(f.steps.at(-1),'failed-paused');assert.ok(!f.steps.includes('resume-db'));assert.ok(!f.steps.includes('switch-0'));
  }
});
test('move: tar checks numeric ownership, rejects links/traversal and foreign uid',()=>{
  const good='-rw------- 10001/10001 20 2026-01-01 00:00 ./history.jsonl\n';validateTarListing(good,10001);
  for(const bad of [good.replace('./history','./../history'),good.replace('10001/10001','10002/10002'),good.replace('-rw-------','lrwxrwxrwx')])assert.throws(()=>validateTarListing(bad,10001));
});
test('knowledge: grantee and owner both authorize; revoked grant at owner denies and no content is read',async()=>{
  const checks=[],owner='bb000000-0000-4000-8000-000000000001';let granted=true,reads=0;
  const runtimeFor=nodeId=>({nodeId,cache:{revision:'9',routeOf:()=>({primary:'node-b',shardId:'1',revision:'9'})},coordination:{members},admit:async()=>{}});
  const appFor=side=>({accounts:{authenticate:async token=>{assert.equal(token,'Bearer end-user');return {userId:user,authorization:token};}},knowledge:{kb:async()=>{checks.push(side);if(side==='owner'&&!granted)throw new (class extends Error{status=404;})();return {owner_id:owner};},read:async()=>{reads++;return {content:'one copy'};},search:async()=>{},pages:async()=>{}},resources:{readById:async()=>{}},permissionHub:{withUser:async(u,fn)=>fn()},gate:{operator:u=>u,run:async(c,fn)=>fn()}});
  const a=runtimeFor('node-a'),b=runtimeFor('node-b'),appA=appFor('grantee'),appB=appFor('owner');attachKnowledge(appA,a);attachKnowledge(appB,b);a.call=async(address,p,body,token)=>{assert.equal(Object.hasOwn(body,'requester'),false);return b.readKnowledge(body,token);};
  assert.equal((await runIdentity({userId:user,authorization:'Bearer end-user'},()=>appA.knowledge.read({kbId:'k',slug:'s'}))).content,'one copy');assert.deepEqual(checks,['grantee','owner']);
  granted=false;await assert.rejects(runIdentity({userId:user,authorization:'Bearer end-user'},()=>appA.knowledge.read({kbId:'k',slug:'s'})),e=>e.status===404);assert.equal(reads,1);
});
test('service: every member may be ready; lost lease stops generation and rejoin uses new generation',async()=>{
  const c=new EventEmitter();Object.assign(c,{nodeId:'node-b',generation:1,alive:true,checkLease(){return this.alive;},isolate(){this.alive=false;this.emit('lost');}});
  let started=0,stopped=0;const service=new ShardedService(c,async g=>{started++;return {stopDispatch(){stopped++;},close:async()=>{}};},{cache:{},prepared:true},()=>{});
  await service.resume();assert.ok(service.isReady());const old=service.generation;c.isolate();await service.chain;assert.equal(service.isReady(),false);assert.throws(()=>old.assert());assert.equal(stopped,1);
  c.alive=true;c.generation++;await service.resume();assert.equal(started,2);assert.ok(service.isReady());await service.stop();
});
test('runtime: background enumeration filters foreign and paused users',async()=>{
  const runtime=new ShardRuntime({nodeId:'node-a',cache:{routeOf:id=>({primary:id==='a'?'node-a':'node-b',shardId:'0'})},coordination:{checkLease:()=>true}});
  runtime.pool={query:async()=>({rows:[{paused:false,shard_id:'0'}]})};assert.deepEqual(await runtime.filter([{id:'a'},{id:'b'}],'id'),[{id:'a'}]);runtime.paused.add('a');assert.deepEqual(await runtime.filter([{id:'a'}],'id'),[]);
});
test('status: shards, slots, user counts and every member revision; missing primary is unavailable',async()=>{
  const c={status:async()=>({members:[members.get('a'),members.get('b')],control:{nodeId:'node-a'},events:[]})};
  const result=await shardStatus(c,{revision:'8',slots:defaultSlots(),shards:{'0':{primary:'node-a',epoch:1},'2':{primary:'node-c',epoch:1}}},{data:{scope:{instanceId:'i'},pool:{query:async()=>({rows:[{node_id:'node-a',users:4}]})}}},{nodes:['node-a','node-b','node-c'],nodeId:'node-a',call:async()=>({revision:'7'})});
  assert.equal(result.shards[1].status,'unavailable');assert.deepEqual(result.routeRevisions,{'node-a':'8','node-b':'7','node-c':null});assert.equal(result.usersPerNode['node-a'],4);assert.equal(Object.values(result.slotDistribution).reduce((a,b)=>a+b),64);
});
test('route: absolute-form incoming URL cannot send node credentials outside the selected primary',async()=>{
  await forwardHttp({method:'GET',url:'http://example.com/events',headers:{}},'http://node-b:4341',{revision:'1'},user,'k'.repeat(32),null,{fetcher:async(url)=>{assert.equal(url.origin,'http://node-b:4341');return new Response();}});
});
test('move: uncertain resume commit never revives the old disk after target may have dispatched',async()=>{
  const f=moveFixture('resume-db');await assert.rejects(moveUser(f.options));
  assert.equal(f.shard(),'1');assert.equal(f.steps.at(-1),'failed-paused');assert.ok(!f.steps.includes('switch-0'));
});
