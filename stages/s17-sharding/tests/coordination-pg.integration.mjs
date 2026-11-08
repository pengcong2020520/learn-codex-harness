import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,migrate,transaction } from '../server/modules/data/database.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
const url=process.env.DATA_TEST_DATABASE_URL;
test('真实 PG：cluster_term 只保护 control 分片元数据；旧 control 仍被 CT001 拒绝', {skip:!url},async t=>{
 const admin=await openDatabase(url,{maintenance:true});t.after(()=>admin.end());await migrate(admin);
 const password='coordination-integration-password';await provisionNodeRoles(admin,{a:password,b:password,c:password},(await admin.query('SELECT current_database() AS db')).rows[0].db);
 const target=new URL(url);target.username='agent_node_a';target.password=password;target.searchParams.set('options','-c app.maintenance=off');
 const pool=await openDatabase(target.href,{maintenance:false});t.after(()=>pool.end());
 const term=BigInt((await admin.query('SELECT term FROM agent_data.cluster_term')).rows[0].term)+1n;
 await pool.query('SELECT agent_data.advance_cluster_term($1::bigint)',[String(term)]);
 const metadata=(value)=>transaction(pool,async db=>{await db.query("SELECT set_config('app.term',$1,true)",[String(value)]);await db.query('DELETE FROM agent_data.shard_owners WHERE false');});
 await metadata(term);await pool.query('SELECT agent_data.advance_cluster_term($1::bigint)',[String(term+1n)]);
 await assert.rejects(metadata(term),{code:'CT001'});await metadata(term+1n);
 await assert.rejects(pool.query('DELETE FROM agent_data.user_shards WHERE false'),{code:'CT001'});
 await assert.rejects(pool.query('UPDATE agent_data.cluster_term SET term=0'),{code:'42501'});
});
