import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase,migrate } from '../server/modules/data/database.mjs';
import { fencePool } from '../server/modules/data/write.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { ReplicationStore } from '../server/modules/replication/store.mjs';
import { ShardControl } from '../server/modules/sharding/control.mjs';
import { ReplicationControl } from '../server/modules/replication/control.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { defaultSlots } from '../server/modules/sharding/strategy.mjs';
import { FakeClient } from './fixtures/coordination-client.mjs';
import { scriptedCoordination } from './fixtures/sharding-cluster.mjs';
const url=process.env.DATA_TEST_DATABASE_URL;
test('真实 PG：接管事务、SH001 位点与旧主隔离、三类任务、旧主全量追平门禁', {skip:!url,timeout:30000},async t=>{
 const admin=await openDatabase(url,{maintenance:true});t.after(()=>admin.end());await migrate(admin);
 const password='replication-test-password-only';await provisionNodeRoles(admin,{a:password,b:password,c:password},(await admin.query('SELECT current_database() AS name')).rows[0].name);
 const instance=randomUUID(),user=randomUUID(),other=randomUUID(),late=randomUUID();
 const foreignInstance=randomUUID(),foreign=randomUUID(),unmapped=randomUUID(),anonymous=randomUUID();
 // One parameter cannot be both uuid (id) and text (username concat): pass usernames separately.
 await admin.query("INSERT INTO agent_data.users(instance_id,id,name,username) VALUES($1,$2,'replica',$4),($1,$3,'new',$5)",[instance,user,other,'replica_'+user,'new_'+other]);
 await admin.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch,replica,replica_ready) VALUES('0','node-a',1,'node-b',true)
   ON CONFLICT(shard_id) DO UPDATE SET node_id='node-a',epoch=1,replica='node-b',replica_ready=true,publishing=false,recovering=false,paused=false`);
 // Do not relocate shared-DB users to make the census pass. Decoys reproduce the mismatch.
 await admin.query("INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES('1','node-b',1) ON CONFLICT DO NOTHING");
 await admin.query("INSERT INTO agent_data.users(instance_id,id,name,username) VALUES($1,$2,'foreign',$3),($1,$4,'unmapped',$5),($6,$7,'anonymous',NULL)",
   [foreignInstance,foreign,'foreign_'+foreign,unmapped,'unmapped_'+unmapped,instance,anonymous]);
 await admin.query("INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,'0'),($2,'1'),($3,'0'),($4,'0')",[user,other,foreign,anonymous]);
 // Foreign-instance and other-shard unfinished copies must not block this shard.
 for(const [id,shard] of [[foreign,'0'],[other,'1']])await admin.query(
   'INSERT INTO agent_data.replication_transfers(user_id,owner_id,shard_id,epoch,token) VALUES($1,$1,$2,2,$3)',[id,shard,randomUUID()]);
 const etcd=new FakeClient();etcd.set('/codex/slots',JSON.stringify(defaultSlots()));etcd.set('/codex/overrides/'+user,'"0"');etcd.set('/codex/shards/0',JSON.stringify({primary:'node-a',replica:'node-b',epoch:1}));
 const cache=await new RouteCache(etcd).open();t.after(()=>cache.close());
 const node=async suffix=>{const u=new URL(url);u.username='agent_node_'+suffix;u.password=password;const p=await openDatabase(u.href,{maintenance:false});t.after(()=>p.end());return p;};
 const a=await node('a'),b=await node('b');
 const fenced=(p,nodeId)=>fencePool(p,{nodeId,routes:cache,assert(){},log(){},isolate(){}});
 const sa=new ReplicationStore(fenced(a,'node-a'),instance),sb=new ReplicationStore(fenced(b,'node-b'),instance);
 assert.deepEqual(await sa.users('0'),[user]);
 await admin.query("INSERT INTO agent_data.conversations(instance_id,id,owner_id,cwd) VALUES($1,'replica-thread',$2,'/tmp')",[instance,user]);
 for(const [id,status] of [['copied','completed'],['tail','completed'],['inflight','running'],['pending','queued']])await admin.query("INSERT INTO agent_data.tasks(instance_id,id,thread_id,text,mode,status,created_at) VALUES($1,$2,'replica-thread','test','enqueue',$3,1)",[instance,id,status]);
 const sequence=(await admin.query("SELECT sequence FROM agent_data.tasks WHERE instance_id=$1 AND id='copied'",[instance])).rows[0].sequence;
 const route={shardId:'0',epoch:1};let token=randomUUID();
 await runOwner(user,async()=>{await sa.begin(user,route,token);await sa.finish(user,route,sequence,'hash',token);});
 await runOwner(user,()=>assert.rejects(sb.begin(user,route,randomUUID()),{code:'SH001'}));
 const term=String(BigInt((await admin.query('SELECT term FROM agent_data.cluster_term WHERE id=1')).rows[0].term)+1n);
 const c=scriptedCoordination({client:etcd,nodeId:'node-a',members:new Map([['node-b',{nodeId:'node-b'}]]),term,isolations:[]});
 const ctl=new ReplicationControl(c,cache,a,instance);ctl.log=()=>{};
 await ctl.switch('0');assert.equal(cache.shards['0'].epoch,2);
 const taken=(await ctl.rows()).find(r=>r.shard_id==='0');
 assert.equal(taken.node_id,'node-b');assert.equal(taken.replica,null);assert.equal(taken.replica_ready,false);assert.equal(taken.previous_primary,'node-a');
 await runOwner(user,()=>assert.rejects(sa.begin(user,route,randomUUID()),{code:'SH001'}));
 await runOwner(user,()=>assert.rejects(sa.pool.query("UPDATE agent_data.tasks SET error='old result' WHERE instance_id=$1",[instance]),{code:'SH001'}));
 await runOwner(user,()=>sb.recover(user,2));
 assert.deepEqual((await admin.query('SELECT id,status FROM agent_data.tasks WHERE instance_id=$1 ORDER BY sequence',[instance])).rows,
 [{id:'copied',status:'completed'},{id:'tail',status:'replica_missing'},{id:'inflight',status:'unconfirmed'},{id:'pending',status:'queued'}]);
 assert.equal((await admin.query("SELECT error FROM agent_data.tasks WHERE instance_id=$1 AND id='tail'",[instance])).rows[0].error,'该轮结果在故障接管时丢失，请核对');
 await ctl.recovered('0',2,'node-b');c.members.set('node-a',{nodeId:'node-a'});await ctl.place();
 assert.equal((await admin.query('SELECT 1 FROM agent_data.user_shards WHERE user_id=$1',[unmapped])).rowCount,0,'placement must not import another instance');
 assert.deepEqual(await sb.users('0'),[user]);
 const returned=(await ctl.rows()).find(r=>r.shard_id==='0');assert.equal(returned.replica,'node-a');assert.equal(returned.replica_ready,false);
 assert.equal(String((await sb.position(user)).epoch),'1','the old epoch snapshot cannot satisfy epoch 2');
 assert.deepEqual(await ctl.ready('0',2,'node-b'),{ready:false});
 token=randomUUID();await runOwner(user,async()=>{await sb.begin(user,{shardId:'0',epoch:2},token);await sb.finish(user,{shardId:'0',epoch:2},sequence,'new-hash',token);});
 // Same epoch on the wrong shard is not a completed baseline for shard 0.
 await admin.query("UPDATE agent_data.replication_positions SET shard_id='1' WHERE user_id=$1",[user]);
 assert.deepEqual(await ctl.ready('0',2,'node-b'),{ready:false});
 await admin.query("UPDATE agent_data.replication_positions SET shard_id='0' WHERE user_id=$1",[user]);
 const census=(await admin.query(`SELECT count(*)::int AS unscoped_missing,
   count(*) FILTER(WHERE a.instance_id=$3)::int AS scoped_missing
   FROM agent_data.user_shards u JOIN agent_data.users a ON a.id=u.user_id
   LEFT JOIN agent_data.replication_positions p ON p.user_id=u.user_id AND p.shard_id=u.shard_id AND p.epoch=$2
   WHERE u.shard_id=$1 AND a.username IS NOT NULL AND p.user_id IS NULL`,['0',2,instance])).rows[0];
 assert.ok(census.unscoped_missing>0);assert.equal(census.scoped_missing,0);
 t.diagnostic('After full copy: '+JSON.stringify(census));
 assert.deepEqual(await ctl.ready('0',2,'node-b'),{ready:true});
 // Even an existing current-epoch position is unusable while its replacement is incomplete.
 token=randomUUID();await runOwner(user,()=>sb.begin(user,{shardId:'0',epoch:2},token));
 assert.deepEqual(await ctl.ready('0',2,'node-b'),{ready:false});c.members.delete('node-b');
 await assert.rejects(ctl.switch('0'),{code:'REPLICA_UNAVAILABLE'});
 await runOwner(user,()=>sb.finish(user,{shardId:'0',epoch:2},sequence,'final-hash',token));
 assert.deepEqual(await ctl.ready('0',2,'node-b'),{ready:true});
 // Actually create this account after ready; place() cannot pre-map it earlier.
 await admin.query("INSERT INTO agent_data.users(instance_id,id,name,username) VALUES($1,$2,'late',$3)",[instance,late,'late_'+late]);
 await admin.query("INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,'0')",[late]);
 etcd.set('/codex/overrides/'+late,'"0"');await cache.refresh();
 assert.deepEqual(await ctl.ready('0',2,'node-b'),{ready:false});
 await assert.rejects(ctl.switch('0'),{code:'REPLICA_UNAVAILABLE'});
 token=randomUUID();await runOwner(late,async()=>{await sb.begin(late,{shardId:'0',epoch:2},token);await sb.finish(late,{shardId:'0',epoch:2},'0','empty-hash',token);});
 assert.deepEqual(await ctl.ready('0',2,'node-b'),{ready:true});
 c.members.set('node-b',{nodeId:'node-b'});
 await ctl.promote('0',async()=>assert.equal((await ctl.rows()).find(r=>r.shard_id==='0').paused,true));
 const promoted=(await ctl.rows()).find(r=>r.shard_id==='0');
 assert.equal(promoted.node_id,'node-a');assert.equal(promoted.replica,null);assert.equal(promoted.replica_ready,false);assert.equal(promoted.previous_primary,'node-b');assert.equal(Number(promoted.epoch),3);
 await ctl.recovered('0',3,'node-a');await ctl.place();
 const rejoined=(await ctl.rows()).find(r=>r.shard_id==='0');
 assert.equal(rejoined.node_id,'node-a');assert.equal(rejoined.replica,'node-b');assert.equal(rejoined.replica_ready,false);

 // Exercise the inherited production UPSERT against the real CHECK constraint.
 // Reconciliation with identical ownership preserves a ready replica; reassignment clears it.
 await admin.query("UPDATE agent_data.shard_owners SET replica_ready=true WHERE shard_id='0'");
 const placement=new ShardControl(c,cache,a);placement.log=()=>{};
 await placement.place();assert.equal((await ctl.rows()).find(r=>r.shard_id==='0').replica_ready,true);
 etcd.set('/codex/shards/0',JSON.stringify({primary:'node-a',epoch:4}));
 await placement.place();
 const renewed=(await ctl.rows()).find(r=>r.shard_id==='0');
 assert.equal(renewed.node_id,'node-a');assert.equal(renewed.replica,null);assert.equal(renewed.replica_ready,false);
 await admin.query("UPDATE agent_data.shard_owners SET replica='node-b',replica_ready=true,previous_primary='node-b' WHERE shard_id='0'");
 etcd.set('/codex/shards/0',JSON.stringify({primary:'node-b',epoch:5}));
 await placement.place();
 const placed=(await ctl.rows()).find(r=>r.shard_id==='0');
 assert.equal(placed.node_id,'node-b');assert.equal(Number(placed.epoch),5);assert.equal(placed.replica,null);assert.equal(placed.replica_ready,false);assert.equal(placed.previous_primary,null);
 await admin.query("UPDATE agent_data.shard_owners SET previous_primary=node_id WHERE shard_id='0'");
 await ctl.place();assert.equal((await ctl.rows()).find(r=>r.shard_id==='0').replica,null,'stale previous_primary must not reattach the current primary');
 // Missing local CODEX_HOME persists loss at conversation scope, without affecting new sessions.
 await admin.query('UPDATE agent_data.replication_positions SET epoch=4 WHERE user_id=$1',[user]);
 await runOwner(user,()=>sb.recover(user,5,{missingHome:true}));
 const lost=(await admin.query("SELECT replica_missing,paused FROM agent_data.conversations WHERE instance_id=$1 AND id='replica-thread'",[instance])).rows[0];
 assert.deepEqual(lost,{replica_missing:true,paused:true});
 assert.equal((await admin.query("SELECT status FROM agent_data.tasks WHERE instance_id=$1 AND id='pending'",[instance])).rows[0].status,'needs-review');
 assert.equal((await admin.query("SELECT status FROM agent_data.tasks WHERE instance_id=$1 AND id='copied'",[instance])).rows[0].status,'replica_missing','missing home loses even tasks at the saved position');
 await admin.query("INSERT INTO agent_data.conversations(instance_id,id,owner_id,cwd) VALUES($1,'fresh-after-loss',$2,'/tmp')",[instance,user]);
 assert.deepEqual((await admin.query("SELECT replica_missing,paused FROM agent_data.conversations WHERE instance_id=$1 AND id='fresh-after-loss'",[instance])).rows[0],{replica_missing:false,paused:false});

});
