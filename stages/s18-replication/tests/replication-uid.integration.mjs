// Real PG roles + Redis + HTTP + native Codex processes under Linux uid isolation.
// The model is simulated; membership double uses production guardedPut/RouteCache wire paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { identity,migrate,openDatabase } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts,addUser } from '../server/modules/accounts/admin.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { defaultSlots } from '../server/modules/sharding/strategy.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
import { cleanup,installToolFixture,tempRoot,until } from './helpers.mjs';
import { answer,responsesFixture } from './responses-fixture.mjs';
import { startClusterNode,scriptedCoordination } from './fixtures/sharding-cluster.mjs';
import { FakeClient } from './fixtures/coordination-client.mjs';
test('Linux 三节点：bob 两轮→复制→停主接管→续聊看到两轮→旧主回归追平',{
 skip:process.platform!=='linux'||process.getuid?.()!==0?'需要 Linux 0:1000、真实 PG/Redis 和 Codex':false,timeout:240000
},async t=>{
 assert.equal(process.getgid(),1000);
 const caps=BigInt('0x'+fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\s+(\w+)/m)[1]);
 assert.equal(caps,[0n,3n,6n,7n].reduce((n,b)=>n|(1n<<b),0n));
 let databaseUrl=process.env.DATA_TEST_DATABASE_URL;const redisUrl=process.env.DATA_TEST_REDIS_URL;assert.ok(databaseUrl&&redisUrl);
 const root=tempRoot(t);fs.chmodSync(root,0o755);const roots=['a','b','c'].map(n=>installToolFixture(path.join(root,'node-'+n)));
 cleanup(root,()=>{const walk=p=>{if(!fs.lstatSync(p).isDirectory())return;fs.chownSync(p,0,1000);fs.chmodSync(p,0o700);for(const n of fs.readdirSync(p))walk(path.join(p,n));};walk(root);});
 const keeper=await openDatabase(databaseUrl,{maintenance:true}),dbName='s18_uid_'+randomUUID().replaceAll('-','');
 await keeper.query('CREATE DATABASE '+dbName);
 cleanup(root,async()=>{await keeper.query('DROP DATABASE '+dbName+' WITH (FORCE)');await keeper.end();});
 const dedicated=new URL(databaseUrl);dedicated.pathname='/'+dbName;databaseUrl=dedicated.href;
 const admin=await openDatabase(databaseUrl,{maintenance:true});cleanup(root,()=>admin.end());await migrate(admin);
 const password='replication-uid-test-password';await provisionNodeRoles(admin,{a:password,b:password,c:password},(await admin.query('SELECT current_database() db')).rows[0].db);
 const scope=identity(roots[0]);for(const dir of roots.slice(1)){fs.mkdirSync(path.join(dir,'.data'),{recursive:true});fs.writeFileSync(path.join(dir,'.data/identity.json'),JSON.stringify(scope));}
 const accounts=new AccountStore(admin,scope.instanceId);
 const owner=await initializeAccounts(accounts,{ownerId:scope.ownerId,username:'admin',password,workspace:path.join(roots[0],'workspace')});
 const bob=await addUser(accounts,{username:'bob',password});
 for(const [id,primary,replica] of [['0','node-a','node-b'],['1','node-b','node-c'],['2','node-c','node-a']])await admin.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch,replica) VALUES($1,$2,1,$3)
 ON CONFLICT(shard_id) DO UPDATE SET node_id=$2,epoch=1,replica=$3,replica_ready=false,publishing=false,recovering=false,paused=false`,[id,primary,replica]);
 // Explicit mappings keep this deployment's accounts independent of earlier uid suites.
 await admin.query("INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,'2'),($2,'0')",[owner.id,bob.id]);
 const etcd=new FakeClient();etcd.set('/codex/slots',JSON.stringify(defaultSlots()));
 for(const [id,primary,replica] of [['0','node-a','node-b'],['1','node-b','node-c'],['2','node-c','node-a']])etcd.set('/codex/shards/'+id,JSON.stringify({primary,replica,epoch:1}));
 etcd.set('/codex/overrides/'+owner.id,'"2"');etcd.set('/codex/overrides/'+bob.id,'"0"');
 const logs=[],isolations=[],members=new Map(),nodes=[];
 const term=String(BigInt((await admin.query('SELECT term FROM agent_data.cluster_term WHERE id=1')).rows[0].term)+1n);
 const provider=await responsesFixture(root,body=>answer(JSON.stringify(body.input).includes('THIRD')?'continued':JSON.stringify(body.input).includes('SECOND')?'SECOND_REPLY':'FIRST_REPLY'));
 const start=async index=>{
  const nodeId='node-'+'abc'[index],cache=await new RouteCache(etcd).open();cleanup(root,()=>cache.close());
  const route=cache.routeOf.bind(cache);cache.routeOf=id=>[bob.id,owner.id].includes(id)?route(id):{primary:null,shardId:null,epoch:null,revision:cache.revision};
  const coordination=scriptedCoordination({client:etcd,nodeId,members,term,isolations,controlNode:'node-c'});
  return startClusterNode({root,nodeRoot:roots[index],databaseUrl,redisUrl,password,provider,cache,coordination,term,logs,isolations,replication:true});
 };
 for(let i=0;i<3;i++)nodes.push(await start(i));
 const api=async(index,route,body,expected,token)=>{
  const response=await fetch(nodes[index].address+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(90000)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify({route,value,logs}));return value;
 };
 const token=(await api(2,'/auth/login',{username:'bob',password},200)).token;
 const session=await api(2,'/sessions',{},201,token);
 const complete=async(index,id,text)=>{
  await api(2,'/messages',{threadId:session.id,clientMessageId:id,text},202,token);
  let job;await until(async()=>{job=await runOwner(bob.id,()=>nodes[index].app.data.jobs.get(id));return ['completed','failed','unconfirmed','interrupted'].includes(job?.status);},60000);
  assert.equal(job.status,'completed',JSON.stringify({job,logs}));
 };
 await complete(0,'one','FIRST remember cobalt');await complete(0,'two','SECOND remember amber');
 const record=(await admin.query('SELECT * FROM agent_data.user_runtimes WHERE user_id=$1',[bob.id])).rows[0];
 const homes=roots.map(dir=>path.join(dir,'.data/users',bob.id,'codex'));
 const created=spawnSync(process.execPath,['-e',`const fs=require('fs'),p=require('path'),h=process.argv[1];fs.mkdirSync(p.join(h,'tmp/arg0/test'),{recursive:true});fs.symlinkSync('/bin/true',p.join(h,'tmp/arg0/test/apply_patch'));fs.writeFileSync(p.join(h,'private-marker'),'two rounds',{mode:384});`,homes[0]],{uid:record.uid,gid:record.uid,cwd:'/',encoding:'utf8'});assert.equal(created.status,0,created.stderr);
 const relative=path.join('workspace/users',bob.id,'output.txt');fs.writeFileSync(path.join(roots[0],relative),'service data');fs.chownSync(path.join(roots[0],relative),0,1000);fs.chmodSync(path.join(roots[0],relative),0o660);
 await until(()=>nodes[0].app.replication.worker.sync(bob.id,{force:true}),30000);
 await nodes[2].control.ready('0',1,'node-a');
 assert.equal(fs.existsSync(path.join(homes[1],'tmp')),false);
 const stat=spawnSync(process.execPath,['-e',`const fs=require('fs'),s=fs.statSync(process.argv[1]);console.log(JSON.stringify([s.uid,s.gid,s.mode&511]));`,path.join(homes[1],'private-marker')],{uid:record.uid,gid:record.uid,encoding:'utf8'});
 // The replica must reproduce the primary's numeric owner exactly. s14 homes are 2770 setgid group 1000,
 // so files created there inherit gid 1000; compare against the primary copy instead of assuming gid=uid.
 const source=spawnSync(process.execPath,['-e',`const fs=require('fs'),s=fs.statSync(process.argv[1]);console.log(JSON.stringify([s.uid,s.gid,s.mode&511]));`,path.join(homes[0],'private-marker')],{uid:record.uid,gid:record.uid,encoding:'utf8'});
 const replica=JSON.parse(stat.stdout);assert.deepEqual(replica,JSON.parse(source.stdout));assert.equal(replica[0],record.uid);assert.equal(replica[2],0o600);const ws=fs.statSync(path.join(roots[1],relative));assert.deepEqual([ws.uid,ws.gid,ws.mode&0o777],[0,1000,0o660]);
 await nodes[0].app.close();nodes[0].generation.active=false;
 await new Promise(resolve=>{nodes[0].server.close(resolve);nodes[0].server.closeAllConnections();});members.delete('node-a');
 await nodes[2].control.switch('0');await nodes[1].app.replication.tick();
 await api(2,'/sessions/resume',{threadId:session.id},200,token);await complete(1,'three','THIRD continue');
 const continued=provider.requests.find(r=>JSON.stringify(r.input).includes('THIRD'));assert.ok(continued);assert.match(JSON.stringify(continued.input),/FIRST_REPLY/);assert.match(JSON.stringify(continued.input),/SECOND_REPLY/);
 nodes[0]=await start(0);await nodes[2].control.place();
 assert.equal((await nodes[2].control.rows()).find(r=>r.shard_id==='0').replica_ready,false);
 await nodes[1].app.replication.tick();
 const returned=(await nodes[2].control.rows()).find(r=>r.shard_id==='0');assert.equal(returned.node_id,'node-b');assert.equal(returned.replica,'node-a');assert.equal(returned.replica_ready,true);
 assert.deepEqual(isolations,[]);assert.deepEqual(provider.errors,[]);
});
