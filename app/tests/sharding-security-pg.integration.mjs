import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, transaction } from '../server/modules/data/database.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
import { ShardControl } from '../server/modules/sharding/control.mjs';
import { ShardRuntime } from '../server/modules/sharding/runtime.mjs';
import { authorizeMove } from '../server/modules/sharding/operations.mjs';
const url=process.env.DATA_TEST_DATABASE_URL;
test('PG: account column grants, operation term/expiry/roles, and both routing windows reject old writes', {skip:!url,timeout:30000},async t=>{
  const admin=await openDatabase(url,{maintenance:true});t.after(()=>admin.end());await migrate(admin);
  const password='security-pg-test-password-1234';await provisionNodeRoles(admin,{a:password,b:password,c:password},(await admin.query('SELECT current_database() AS db')).rows[0].db);
  const target=new URL(url);target.username='agent_node_a';target.password=password;target.searchParams.set('options','-c app.maintenance=off');
  const node=await openDatabase(target.href,{maintenance:false});t.after(()=>node.end());
  const instance=randomUUID(),user=randomUUID();
  await admin.query("INSERT INTO agent_data.users(instance_id,id,name) VALUES($1,$2,'security')",[instance,user]);
  await admin.query("INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES('0','node-a',5),('1','node-b',9) ON CONFLICT(shard_id) DO UPDATE SET replica=NULL,replica_ready=false,node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch");
  await admin.query("INSERT INTO agent_data.user_shards VALUES($1,'0',false)",[user]);
  const asNode=fn=>transaction(node,async db=>{await db.query("SET LOCAL app.node='node-a'; SET LOCAL app.shard_epoch='5'");return fn(db);});
  for(const column of ['role','password_hash','username','disabled_at'])await assert.rejects(asNode(db=>db.query(`UPDATE agent_data.users SET ${column}=${column} WHERE id=$1`,[user])),{code:'42501'});
  await assert.rejects(asNode(db=>db.query("INSERT INTO agent_data.users(instance_id,id,name) VALUES($1,$2,'forbidden')",[instance,randomUUID()])),{code:'42501'});
  await asNode(db=>db.query('UPDATE agent_data.users SET plan_id=plan_id WHERE id=$1',[user]));
  const session=randomUUID();
  await asNode(db=>db.query("INSERT INTO agent_data.auth_sessions(instance_id,id,user_id,token_hash,created_at,last_seen_at,expires_at,client_hint) VALUES($1,$2,$3,$4,now(),now(),now()+interval '1 day','CLI')",[instance,session,user,'a'.repeat(64)]));
  await asNode(db=>db.query('UPDATE agent_data.auth_sessions SET last_seen_at=now(),revoked_at=now() WHERE id=$1',[session]));
  await assert.rejects(asNode(db=>db.query('DELETE FROM agent_data.auth_sessions WHERE id=$1',[session])),{code:'42501'});
  await assert.rejects(asNode(db=>db.query('UPDATE agent_data.auth_sessions SET token_hash=token_hash WHERE id=$1',[session])),{code:'42501'});
  const hash='b'.repeat(64);await asNode(db=>db.query("INSERT INTO agent_data.agent_versions(instance_id,hash,descriptor) VALUES($1,$2,'{}')",[instance,hash]));
  await assert.rejects(asNode(db=>db.query('UPDATE agent_data.agent_versions SET descriptor=descriptor WHERE instance_id=$1',[instance])),{code:'42501'});
  const term=String(BigInt((await admin.query('SELECT term FROM agent_data.cluster_term WHERE id=1')).rows[0].term)+1n);
  let route={shardId:'0',primary:'node-a',epoch:5}, published=false;
  const cache={routeOf:()=>route,refresh:async()=>{}};
  const coordination={nodeId:'node-a',assertController(){},confirm:async()=>{},term:()=>term,checkLease:()=>true,guardedPut:async()=>{
    // Separate connection observes committed SQL before any etcd write.
    const row=(await admin.query('SELECT u.shard_id,o.state FROM agent_data.user_shards u JOIN agent_data.move_operations o USING(user_id) WHERE o.id=$1',[operation.id])).rows[0];
    assert.deepEqual(row,{shard_id:'1',state:'switched'});published=true;
  }};
  const control=new ShardControl(coordination,cache,node);
  const operation=await control.beginMove(user,'1');assert.equal(operation.state,'paused');assert.equal(+operation.expires_at - +operation.created_at,30*60*1000);
  await assert.rejects(node.query("UPDATE agent_data.move_operations SET state='copying' WHERE id=$1",[operation.id]),{code:'CT001'});
  const args={operationId:operation.id,userId:user,caller:'node-a',receiver:'node-a',step:'pause'};
  await authorizeMove(node,args);
  for(const patch of [{userId:randomUUID()},{caller:'node-b'},{operationId:randomUUID()}])await assert.rejects(authorizeMove(node,{...args,...patch}),{status:403});
  await control.advanceMove(operation.id,'paused','copying');await control.advanceMove(operation.id,'copying','copied');
  await assert.rejects(authorizeMove(node,args),{status:403});
  const runtime=new ShardRuntime({nodeId:'node-a',cache,coordination});runtime.pool=node;
  const write=()=>asNode(db=>db.query("INSERT INTO agent_data.preferences(instance_id,owner_id,key,value) VALUES($1,$2,$3,'value')",[instance,user,randomUUID()]));
  // An old/errant etcd publish cannot authorize the former primary while SQL is still on source.
  route={shardId:'1',primary:'node-b',epoch:9};assert.equal(await runtime.canDispatch(user),false);await assert.rejects(write(),{code:'SH001'});
  // SQL commits first, but the old node's Watch has not observed the override.
  route={shardId:'0',primary:'node-a',epoch:5};await control.switchUser(user,'1',operation.id);assert.equal(published,true);
  assert.equal(await runtime.canDispatch(user),false);await assert.rejects(write(),{code:'SH001'});
  await authorizeMove(node,{...args,step:'resume',receiver:'node-b'});
  await admin.query("UPDATE agent_data.move_operations SET created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",[operation.id]);
  await assert.rejects(authorizeMove(node,{...args,step:'resume',receiver:'node-b'}),{status:403});
  await assert.rejects(control.finishMove(operation),{status:403});
  assert.equal((await admin.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1',[user])).rows[0].paused,true);
});
