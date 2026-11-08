// Dedicated external PG acceptance. Never reads production .env.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, transaction } from '../server/modules/data/database.mjs';
import { Hub } from '../server/modules/hub/index.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
const url = process.env.DATA_TEST_DATABASE_URL;
if (!url) throw new Error('设置 DATA_TEST_DATABASE_URL 指向专用 PG 验收库。');
test('Hub PG：迁移重复、授权约束/并发上限、scope 联动、审批事务、审计只追加', async t => {
  const pool = await openDatabase(url); t.after(() => pool.end());
  await migrate(pool); await migrate(pool);
  const sql = fs.readFileSync(new URL('../server/modules/data/migrations/013-hub.sql',import.meta.url),'utf8');
  await transaction(pool, c => c.query(sql)); await transaction(pool, c => c.query(sql));
  const instanceId=randomUUID(), ids={};
  for(const name of ['alice','bob','carol','dave',...Array.from({length:21},(_,i)=>`u${i}`)]) {
    ids[name]=randomUUID(); await pool.query('INSERT INTO agent_data.users(instance_id,id,name,username,role) VALUES($1,$2,$3,$3,$4)',[instanceId,ids[name],name,name==='alice'?'admin':'user']);
  }
  const hub=new Hub({pool,instanceId}), as=(name,op)=>runOwner(ids[name],()=>hub.withUser(ids[name],op));
  const create=id=>pool.query('INSERT INTO agent_data.knowledge_bases(instance_id,id,owner_id,source_root,wiki_root) VALUES($1,$2,$3,$4,$5)',[instanceId,id,ids.bob,`inputs/${id}`,`research/${id}/wiki`]);
  await create('general');
  assert.equal((await hub.user(ids.bob)).plan_id,'basic');
  await as('bob',()=>hub.grantKnowledge('general','carol'));
  await as('carol',()=>{hub.checkResource('knowledge','general');assert.throws(()=>hub.checkResource('knowledge','general','modify'),e=>e.status===403);});
  await as('dave',()=>assert.throws(()=>hub.checkResource('knowledge','general'),e=>e.status===404));
  const rawGrant=(kb,target)=>pool.query('INSERT INTO agent_data.resource_grants(instance_id,resource_type,resource_id,grantee_id,granted_by) VALUES($1,\'knowledge\',$2,$3,$4)',[instanceId,kb,target,ids.bob]);
  await assert.rejects(rawGrant('general',ids.carol),e=>e.code==='23505');
  await assert.rejects(rawGrant('general',ids.bob),/cannot grant to owner/);
  await pool.query('UPDATE agent_data.users SET disabled_at=now() WHERE instance_id=$1 AND id=$2',[instanceId,ids.dave]);
  await assert.rejects(rawGrant('general',ids.dave),/disabled/);
  await assert.rejects(rawGrant('missing',ids.carol),/missing/);
  await as('bob',()=>hub.revoke('knowledge','general','carol'));
  assert.equal((await pool.query('SELECT visibility FROM agent_data.knowledge_bases WHERE instance_id=$1 AND id=\'general\'',[instanceId])).rows[0].visibility,'private');
  // 21 independent connections race for 20 places; trigger serializes on resource row.
  const races=await Promise.allSettled(Array.from({length:21},(_,i)=>rawGrant('general',ids[`u${i}`])));
  assert.equal(races.filter(r=>r.status==='fulfilled').length,20);
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_data.resource_grants WHERE instance_id=$1',[instanceId])).rows[0].n,20);
  await assert.rejects(pool.query("UPDATE agent_data.knowledge_bases SET visibility='private' WHERE instance_id=$1 AND id='general'",[instanceId]),/scope must match/);
  await assert.rejects(pool.query("UPDATE agent_data.resource_grants SET granted_by=granted_by WHERE instance_id=$1",[instanceId]),/replace grants/);
  await as('alice',()=>hub.publish('general')); assert.equal((await pool.query('SELECT count(*)::int n FROM agent_data.resource_grants WHERE instance_id=$1',[instanceId])).rows[0].n,0);
  await as('alice',()=>hub.publish('general',false));
  const skill=await as('bob',()=>hub.upload({name:'notes',files:{'SKILL.md':'---\nname: notes\ndescription: notes\n---\n# Notes'}}));
  await as('bob',()=>hub.shareSkill(skill.id,['carol']));
  await as('carol',()=>assert.throws(()=>hub.checkResource('skill',skill.id),e=>e.status===404));
  await as('alice',()=>hub.reviewSkill(skill.id,true)); await as('carol',()=>hub.checkResource('skill',skill.id));
  await as('bob',()=>hub.revoke('skill',skill.id,'carol'));
  await as('bob',()=>hub.shareSkill(skill.id,['carol'])); await as('alice',()=>hub.reviewSkill(skill.id,false));
  await as('alice',()=>hub.assign('bob','pro'));
  await migrate(pool); await transaction(pool,c=>c.query(sql));
  assert.equal((await hub.user(ids.bob)).plan_id,'pro','重跑不能重置已分配权益');
  for(const statement of ['UPDATE agent_data.permission_events SET action=action WHERE instance_id=$1','DELETE FROM agent_data.permission_events WHERE instance_id=$1']) await assert.rejects(pool.query(statement,[instanceId]),/append-only/);
  await assert.rejects(pool.query('TRUNCATE agent_data.permission_events'),/append-only/);
  assert.ok((await pool.query('SELECT count(*)::int n FROM agent_data.permission_events WHERE instance_id=$1',[instanceId])).rows[0].n>=10);
  console.log('PASS: PG constraints, grants <=20 under race, repeatable migration, UPDATE/DELETE/TRUNCATE rejected. Audit evidence retained in dedicated test database.');
});
