import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase, migrate, transaction } from '../server/modules/data/database.mjs';
import { fencePool } from '../server/modules/data/write.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
const url = process.env.DATA_TEST_DATABASE_URL;
test('真实 PG：SH001 拒绝非 owner、过期 epoch、角色伪装和迁移后的旧主；切换等待旧事务', {skip:!url,timeout:30000}, async t=>{
  const admin=await openDatabase(url,{maintenance:true});t.after(()=>admin.end());await migrate(admin);
  const password='sharding-integration-only-password';const database=(await admin.query('SELECT current_database() AS db')).rows[0].db;
  await provisionNodeRoles(admin,{a:password,b:password,c:password},database);
  const node=async suffix=>{const target=new URL(url);target.username='agent_node_'+suffix;target.password=password;target.searchParams.set('options','-c app.maintenance=off');const p=await openDatabase(target.href,{maintenance:false});t.after(()=>p.end());return p;};
  const a=await node('a'),b=await node('b');const instance=randomUUID(),user=randomUUID(),other=randomUUID();
  await admin.query('INSERT INTO agent_data.users(instance_id,id,name) VALUES($1,$2,\'shard-test\'),($1,$3,\'other\')',[instance,user,other]);
  await admin.query(`INSERT INTO agent_data.shard_owners VALUES('0','node-a',5),('1','node-b',9) ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch`);
  await admin.query('INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,\'0\'),($2,\'1\')',[user,other]);
  const write=(pool,nodeId,epoch,sql,args)=>transaction(pool,async db=>{
    await db.query("SELECT set_config('app.node',$1,true),set_config('app.shard_epoch',$2,true)",[nodeId,String(epoch)]);return db.query(sql,args);
  });
  const insert='INSERT INTO agent_data.preferences(instance_id,owner_id,key,value) VALUES($1,$2,$3,\'value\')';
  await write(a,'node-a',5,insert,[instance,user,'first']);
  await assert.rejects(write(b,'node-b',5,insert,[instance,user,'foreign']),{code:'SH001'});
  await assert.rejects(write(a,'node-a',4,insert,[instance,user,'stale']),{code:'SH001'});
  await assert.rejects(write(b,'node-a',5,insert,[instance,user,'spoof']),{code:'SH001'});
  await assert.rejects(a.query('UPDATE agent_data.preferences SET value=\'missing\' WHERE instance_id=$1',[instance]),{code:'SH001'});
  const isolated = [], logs = [];
  const routes = { refresh: async () => {}, routeOf: id => id === user
    ? { primary: 'node-a', shardId: '0', epoch: 5 } : { primary: 'node-b', shardId: '1', epoch: 9 } };
  const fenced = fencePool(a, { nodeId: 'node-a', routes, assert() {}, log: line => logs.push(line), isolate: reason => isolated.push(reason) });
  await runOwner(user, () => assert.rejects(fenced.query(insert, [instance, other, 'wrong-row']), error => {
    assert.equal(error.code, 'SH001'); assert.equal(error.table, 'preferences');
    const row = JSON.parse(error.detail);
    assert.equal(row.ownerId, other); assert.equal(row.nodeId, 'node-a'); assert.equal(row.primary, 'node-b');
    assert.equal(row.suppliedEpoch, '5'); assert.equal(row.epoch, '9');
    assert.equal(error.databaseDiagnostic.classification, 'wrong-shard-write'); return true;
  }));
  assert.deepEqual(isolated, [], 'a foreign row is a programming error, not a stale local primary');
  assert.match(logs[0], /sharding-pg.integration.mjs/);
  const stale = fencePool(b, { nodeId: 'node-b', routes: { refresh: async () => {}, routeOf: () => ({ primary: 'node-b', shardId: '1', epoch: 8 }) },
    assert() {}, log: line => logs.push(line), isolate: reason => isolated.push(reason) });
  await runOwner(other, () => assert.rejects(stale.query(insert, [instance, other, 'stale-primary']), { code: 'SH001' }));
  assert.deepEqual(isolated, ['database-stale-shard']);
  // Related rows resolve owner through conversation, rather than expecting an owner_id column on tasks.
  await write(a,'node-a',5,'INSERT INTO agent_data.conversations(instance_id,id,owner_id,cwd) VALUES($1,\'t\',$2,\'/tmp\')',[instance,user]);
  const task="INSERT INTO agent_data.tasks(instance_id,id,thread_id,text,mode,status,created_at) VALUES($1,'j','t','hello','enqueue','queued',1)";
  await assert.rejects(write(b,'node-b',9,task,[instance]),{code:'SH001'});await write(a,'node-a',5,task,[instance]);
  await assert.rejects(write(a,'node-a',5,'UPDATE agent_data.conversations SET owner_id=$2 WHERE instance_id=$1',[instance,other]),{code:'SH001'});
  const writer=await a.connect(),mover=await admin.connect();
  try {
    await writer.query('BEGIN');await writer.query("SET LOCAL app.node='node-a'; SET LOCAL app.shard_epoch='5'");
    await writer.query('UPDATE agent_data.preferences SET value=\'in-flight\' WHERE instance_id=$1',[instance]);
    const pid=(await mover.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const move=mover.query("UPDATE agent_data.user_shards SET shard_id='1' WHERE user_id=$1",[user]);
    let waits=false;
    for(let n=0;n<100;n++){waits=(await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock';if(waits)break;await delay(10);}
    assert.ok(waits,'migration must wait for old writer');await writer.query('COMMIT');await move;
  }finally{await writer.query('ROLLBACK');writer.release();mover.release();}
  await assert.rejects(write(a,'node-a',5,'UPDATE agent_data.tasks SET status=\'failed\' WHERE instance_id=$1',[instance]),{code:'SH001'});
  await write(b,'node-b',9,'UPDATE agent_data.tasks SET status=\'completed\' WHERE instance_id=$1',[instance]);
  // No protected table silently loses its guard in a later migration.
  const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='agent_data' AND tablename NOT IN ('migrations','cluster_term')")).rows;
  for(const {tablename} of tables){const guards=await admin.query("SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname IN ('cluster_term_guard','global_node_guard','shard_owner_guard') AND tgenabled='O'",['agent_data.'+tablename]);assert.equal(guards.rowCount,1,tablename);}
});
