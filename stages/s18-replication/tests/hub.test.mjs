import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { hubFixture } from './hub-fixture.mjs';
import { effectiveTools, PLANS, quota } from '../server/modules/hub/policy.mjs';
import { validateUpload } from '../server/modules/hub/skills.mjs';
import { installSkills } from '../server/modules/codex/skills.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { RuntimePool } from '../server/modules/runtimes/pool.mjs';
import { hubRoute } from '../server/modules/hub/routes.mjs';
import { runHub } from '../client/hub.mjs';
import { currentIdentity, runOwner } from '../server/modules/accounts/context.mjs';
import { asUser, rig } from './helpers.mjs';

test('服务测试入口：owner 与 Hub 快照一致，每次调用重新鉴权且退出后不泄漏', async () => {
  const { hub } = hubFixture();
  assert.throws(() => hub.current(), /Hub 缺少可信权限快照/);
  await asUser(hub, 'bob', () => hub.grantKnowledge('general', 'carol'));
  await asUser(hub, 'carol', async () => {
    await Promise.resolve();
    assert.equal(currentIdentity().userId, 'carol');
    assert.equal(hub.current().user.id, 'carol');
    hub.checkResource('knowledge', 'general');
  });
  await asUser(hub, 'bob', () => hub.revoke('knowledge', 'general', 'carol'));
  await assert.rejects(asUser(hub, 'carol', () => hub.checkResource('knowledge', 'general')), error => error.status === 404);
  assert.equal(currentIdentity(), undefined);
  assert.throws(() => hub.current(), /Hub 缺少可信权限快照/);
});

test('Hub 交集：Agent 白名单 ∩ 权益 ∩ scope', () => {
  const agent = { tools: { allow: ['read_file','kb_read','read_webpage','private_tool'] } };
  const groups = [{ id: 'files', scope: 'system', tools: ['read_file','shell'] }, { id: 'knowledge', scope: 'system', tools: ['kb_read'] }, { id: 'web', scope: 'system', tools: ['read_webpage'] }, { id: 'files', scope: 'private', owner_id: 'other', tools: ['private_tool'] }];
  assert.deepEqual(effectiveTools({ id: 'bob', plan: PLANS.basic }, agent, groups), ['read_file','kb_read']);
  assert.deepEqual(effectiveTools({ id: 'bob', plan: PLANS.pro }, agent, groups), ['read_file','kb_read','read_webpage']);
  assert.ok(!effectiveTools({ id: 'alice', role: 'admin' }, agent, groups).includes('shell'));
});
test('Hub scope：private 404；授权只能读用，修改/删除/再分享 403；禁用授权不生效', async () => {
  const { hub, as, state } = hubFixture();
  await as('carol', () => assert.throws(() => hub.checkResource('knowledge','general'), e => e.status === 404));
  await as('bob', () => hub.grantKnowledge('general','carol'));
  await as('carol', () => {
    for (const action of ['use','read']) hub.checkResource('knowledge','general', action);
    for (const action of ['modify','share','delete']) assert.throws(() => hub.checkResource('knowledge','general', action), e => e.status === 403);
    assert.deepEqual(hub.visible().find(r => r.type === 'knowledge').actions, ['use','read']);
  });
  await as('dave', () => assert.throws(() => hub.checkResource('knowledge','general'), e => e.status === 404));
  state.users.find(u => u.id === 'carol').disabled_at = 'disabled';
  await assert.rejects(as('carol', () => {}), e => e.status === 404); assert.equal(state.grants.length, 1);
});
test('Hub grants：20 人上限、重复、自己、禁用、未知账号，最后撤销回 private', async () => {
  const { hub, as, state } = hubFixture();
  await assert.rejects(as('alice', () => hub.grantKnowledge('general', 'alice')), e => e.status === 400);
  await as('bob', async () => {
    for (const name of ['bob','missing']) await assert.rejects(hub.grantKnowledge('general', name), e => e.status === 400);
    state.users.find(u => u.id === 'dave').disabled_at = 'disabled';
    await assert.rejects(hub.grantKnowledge('general','dave'), e => e.status === 400);
    for (let i = 0; i < 21; i++) state.users.push({ id: `u${i}`, username: `u${i}`, role: 'user', plan_id: 'basic' });
    for (let i = 0; i < 20; i++) await hub.grantKnowledge('general', `u${i}`);
    await hub.grantKnowledge('general','u0'); assert.equal(state.grants.length, 20);
    await assert.rejects(hub.grantKnowledge('general','u20'), e => e.status === 409);
    for (let i = 0; i < 20; i++) await hub.revoke('knowledge','general', `u${i}`);
    assert.equal(state.knowledge[0].visibility, 'private');
  });
});
test('Hub Skill：pending→approve→同步，reject，自批拒绝，撤销立即移除', async t => {
  const { hub, as, state } = hubFixture(), root = fs.mkdtempSync(path.join(os.tmpdir(),'s18-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const synced = [];
  hub.syncSkills = async owners => { for (const owner of owners) { synced.push(owner); installSkills({ skills: await hub.allowedSkills(owner) }, path.join(root,owner)); } };
  const { id } = await as('bob', () => hub.upload({ name: 'notes', files: { 'SKILL.md': '# Notes', 'references/a.md': 'text' } }));
  assert.equal((await hub.allowedSkills('alice')).length, 0, 'admin 可审阅，但私有上传不自动安装给 admin');
  assert.deepEqual(synced, ['bob']); assert.ok(fs.existsSync(path.join(root,'bob/skills',id,'SKILL.md')));
  await as('bob', () => hub.shareSkill(id,['carol'])); assert.equal(state.requests[0].status,'pending'); assert.equal((await hub.allowedSkills('carol')).length,0);
  await assert.rejects(as('bob', () => hub.reviewSkill(id,true)), e => e.status === 403);
  await as('alice', () => hub.reviewSkill(id,true)); const running = await hub.snapshot('carol');
  assert.equal(state.requests[0].status,'approved'); assert.ok(fs.existsSync(path.join(root,'carol/skills',id,'SKILL.md')));
  await assert.rejects(as('carol', () => hub.shareSkill(id,['dave'])), e => e.status === 403);
  await as('bob', () => hub.revoke('skill',id,'carol')); assert.equal(fs.existsSync(path.join(root,'carol/skills',id)),false);
  hub.run(running, () => hub.checkResource('skill',id));
  await as('carol', () => assert.throws(() => hub.checkResource('skill',id), e => e.status === 404));
  await as('bob', () => hub.shareSkill(id,['carol'])); await as('alice', () => hub.reviewSkill(id,false));
  assert.equal(state.requests[0].status,'rejected'); assert.equal((await hub.allowedSkills('carol')).length,0);
  const own = await as('alice', () => hub.upload({ name: 'admin-note', files: { 'SKILL.md': '# Text' } }));
  await as('alice', () => hub.shareSkill(own.id,['bob'])); await assert.rejects(as('alice', () => hub.reviewSkill(own.id,true)), e => e.status === 403);
  assert.ok(state.events.some(e => e.action === 'skill:approve')); assert.ok(state.events.some(e => e.action === 'skill:reject'));
});
test('Hub Skill 校验：128 KiB 总量、路径、代码附件、缺失正文、权益数量', async () => {
  for (const files of [{ 'references/a.txt':'x' }, { 'SKILL.md':'# OK','run.js':'x' }, { 'SKILL.md':'# OK','references/../evil.md':'x' }, { 'SKILL.md':'x'.repeat(128*1024+1) }]) assert.throws(() => validateUpload({ name:'notes', files }));
  assert.doesNotThrow(() => validateUpload({ name:'notes', files:{ 'SKILL.md':'x'.repeat(128*1024) } }));
  const { hub, as } = hubFixture();
  for (let i=0;i<3;i++) await as('bob', () => hub.upload({ name:`note-${i}`, files:{ 'SKILL.md':'# X' } }));
  await assert.rejects(as('bob', () => hub.upload({ name:'note-4', files:{ 'SKILL.md':'# X' } })), e => e.status===403);
});
test('Hub 生效边界：降级/撤销/取消发布不改变运行轮次，下一轮重新鉴权', async () => {
  const { hub, state, as, agent } = hubFixture();
  await as('alice', () => hub.assign('carol','pro')); await as('bob', () => hub.grantKnowledge('general','carol'));
  const gate = new PermissionGate({ scope:{ ownerId:'carol' }, permissionHub:hub, agent:{ definition:{agent}, assertCurrent(){}, allowsTool:()=>true } });
  await as('carol', () => gate.start({ id:'job', userId:'carol', threadId:'t' })); gate.started('t','turn');
  await as('bob', () => hub.revoke('knowledge','general','carol')); await as('alice', () => hub.assign('carol','basic'));
  await gate.run(gate.forTurn('t','turn'), () => { gate.check('tool.call',{name:'read_webpage'}); gate.check('read',{kbId:'general'}); });
  await as('carol', () => { assert.throws(() => hub.checkTool('read_webpage',{definition:{agent}}), e=>e.status===404); assert.throws(() => hub.checkResource('knowledge','general'),e=>e.status===404); });
  await as('alice', () => hub.publish('general')); const published = await hub.snapshot('carol'); await as('alice', () => hub.publish('general',false));
  hub.run(published, () => hub.checkResource('knowledge','general'));
  await as('carol', () => assert.throws(() => hub.checkResource('knowledge','general'),e=>e.status===404));
  gate.end('t','turn'); assert.throws(()=>gate.forTurn('t','turn')); assert.equal(state.events.filter(e=>e.action==='plan:assign').length,2);
});
test('Hub 配额：按 owner 与时区汇总、次日恢复、admin 豁免、并发上限', async () => {
  const { hub,state,time }=hubFixture();
  state.usage.push({owner:'bob',tokens:200000,time:Date.parse('2026-11-07T10:00:00Z')},{owner:'carol',tokens:1,time:Date.parse('2026-11-07T10:00:00Z')});
  assert.equal((await hub.plan('bob')).exceeded,true); assert.equal((await hub.plan('carol')).used,1);
  time(Date.parse('2026-11-08T09:00:01Z')); assert.equal((await hub.plan('bob')).exceeded,false);
  assert.equal(quota({role:'admin'},9999999,0).exceeded,false);
  assert.equal(quota({plan:PLANS.basic},0,1).concurrencyBlocked,true); assert.equal(quota({plan:PLANS.pro},0,1).concurrencyBlocked,false); assert.equal(quota({role:'admin'},0,2).concurrencyBlocked,true);
});
test('Hub 调度：超额保留 queued，次日恢复，basic 一轮/pro 两轮，降级不中断', async t => {
  const r=await rig(t), {hub,state,time}=hubFixture(); const first=r.session, second=await r.sessions.create();
  r.messages.queue={close:async()=>{}};
  await r.submit('one','quota-one','enqueue',null,first.id); await r.submit('two','quota-two','enqueue',null,second.id);
  for(const job of r.messages.store.state.jobs) job.userId='bob';
  for(const session of r.sessions.sessions.values()) session.ownerId='bob';
  r.messages.permissionHub=hub;
  state.usage.push({owner:'bob',tokens:200000,time:Date.parse('2026-11-07T10:00:00Z')});
  await runOwner('bob',()=>r.messages.dispatch(first.id)); assert.equal(r.messages.job('quota-one').status,'queued');
  time(Date.parse('2026-11-08T09:00:01Z'));
  await runOwner('bob',()=>r.messages.dispatch(first.id)); assert.equal(r.messages.job('quota-one').status,'running');
  await runOwner('bob',()=>r.messages.dispatch(second.id)); assert.equal(r.messages.job('quota-two').status,'queued');
  state.users.find(u=>u.id==='bob').plan_id='pro';
  await runOwner('bob',()=>r.messages.dispatch(second.id)); assert.equal(r.messages.job('quota-two').status,'running');
  state.users.find(u=>u.id==='bob').plan_id='basic'; assert.equal(r.messages.job('quota-one').status,'running'); assert.equal(r.messages.job('quota-two').status,'running');
});
test('Hub runtime：集合变化只重启空闲对应用户，旧进程先关闭', async t => {
  let generation=1,active=true; const calls=[];
  const pool=new RuntimePool({shouldRestart:async(owner,value)=>!active&&value.generation!==generation,create:async owner=>{calls.push(`start:${owner}`);return {generation,rpc:new EventEmitter(),close:async()=>calls.push(`close:${owner}`)};}});
  t.after(()=>pool.close()); await pool.withOwner('bob',()=>{}); await pool.withOwner('carol',()=>{});generation++;
  await pool.withOwner('bob',value=>assert.equal(value.generation,1));active=false;await pool.withOwner('bob',value=>assert.equal(value.generation,2));
  assert.deepEqual(calls,['start:bob','start:carol','close:bob','start:bob']);
});
test('Hub routes 与 CLI：保留权限错误；撤销走 DELETE',async()=>{
  const {hub,as}=hubFixture();await assert.rejects(as('dave',()=>hubRoute(hub,'POST','/hub/knowledge/general/grants',async()=>({username:'carol'}))),e=>e.status===404);
  const calls=[];await runHub(['unshare','general','carol'],{request:(...args)=>calls.push(args)});assert.deepEqual(calls[0],['/hub/knowledge/general/grants/carol',undefined,undefined,'DELETE']);
});

test('Hub knowledge：已挂载共享库下一轮重验；后来共享的库也记入会话', async () => {
  const { SessionService } = await import('../server/modules/sessions/index.mjs');
  const { hub, as, agent } = hubFixture();
  const row = { hub_knowledge: [] }, writes=[];
  const service = { permissionHub: hub, config: { agent: { definition:{agent}, input: text => [text] } },
    assertCompatible: async()=>{}, beforeTurn:async()=>{}, repository:{ conversation:async()=>row, query:async(sql,args)=>{writes.push(sql);row.hub_knowledge=args[1];} } };
  const prepare=()=>SessionService.prototype.prepareInput.call(service,'thread','next','hash');
  await as('carol',prepare); assert.deepEqual(row.hub_knowledge,[]);
  await as('bob',()=>hub.grantKnowledge('general','carol')); await as('carol',prepare);
  assert.deepEqual(row.hub_knowledge,['general']); assert.equal(writes.length,1);
  await as('bob',()=>hub.revoke('knowledge','general','carol'));
  await assert.rejects(as('carol',prepare),e=>e.status===404);
});

test('Hub knowledge：真实共享原文读取、版本哈希；KB 与直接 RAG 入口均先授权', async t => {
  const { Resources } = await import('../server/modules/data/resources.mjs');
  const { KnowledgeService } = await import('../server/modules/knowledge/index.mjs');
  const { RagIndex } = await import('../server/modules/knowledge/rag.mjs');
  const { createHash, randomUUID } = await import('node:crypto');
  const { hub,as,agent,state }=hubFixture();
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'s18-shared-read-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const owner of ['bob','carol']) fs.mkdirSync(path.join(root,'users',owner,'inputs/general'),{recursive:true});
  fs.writeFileSync(path.join(root,'users/bob/inputs/general/a.md'),'# Shared');
  const id=randomUUID(),version=randomUUID(),revision=createHash('sha256').update('# Shared').digest('hex');
  const resource={id,owner_id:'bob',locator:'inputs/general/a.md',kind:'original',state:'ready',current_version:version};
  const scope={instanceId:'test',ownerId:'carol'}, agentObject={definition:{agent,bindings:{}},assertCurrent(){},sources:[{id:'inputs',locator:'inputs',actions:['read']}],outputs:{directory:'outputs'}};
  const gate=new PermissionGate({scope,agent:agentObject,permissionHub:hub});
  const pool={query:async sql=>({rows:sql.includes('knowledge_bases')?[state.knowledge[0]]:sql.includes('user_runtimes')?[{uid:process.getuid()}]:sql.includes('resource_versions')?[{revision}]:sql.includes('WITH RECURSIVE')?[]:[resource]})};
  const resources=new Resources(pool,scope,{files:{workspace:path.join(root,'users/carol')},sources:agentObject.sources,outputs:agentObject.outputs,blobDir:path.join(root,'blobs'),gate});
  const kb=new KnowledgeService(pool,scope,{agent:agentObject,gate,resources});
  const read=()=>as('carol',()=>gate.run(gate.user(),()=>resources.readById(id)));
  await assert.rejects(read(),e=>e.status===404);
  await as('bob',()=>hub.grantKnowledge('general','carol'));
  assert.equal((await read()).content,'# Shared');
  await as('carol',()=>gate.run(gate.user(),async()=>{await kb.kb('general');await assert.rejects(kb.kb('general','update'),e=>e.status===403);}));
  fs.writeFileSync(path.join(root,'users/bob/inputs/general/a.md'),'changed');await assert.rejects(read(),e=>e.code==='SOURCE_STALE');
  await as('bob',()=>hub.revoke('knowledge','general','carol'));
  await assert.rejects(as('carol',()=>gate.run(gate.user(),()=>RagIndex.prototype.search.call({},kb,state.knowledge[0],'query',5))),e=>e.status===404);
});


test('Hub Skill：系统包保留原元数据且只安装一次，私有包不复制给 admin', async () => {
  const {hub,as}=hubFixture();
  const system={id:'system-note',scope:'system',source:'/trusted/skill',files:['SKILL.md'],version:'v1'};
  const catalog=hub.catalog; hub.catalog=()=>[...catalog(),{...system,type:'skill'}];hub.systemSkills=()=>[system];
  await as('bob',()=>hub.upload({name:'private-note',files:{'SKILL.md':'# Note'}}));
  const skills=await hub.allowedSkills('bob');
  assert.equal(skills.filter(s=>s.id==='system-note').length,1);assert.equal(skills.length,2);assert.equal(skills[0].source,'/trusted/skill');
  assert.deepEqual((await hub.allowedSkills('alice')).map(s=>s.id),['system-note']);
});


test('Hub knowledge：派生产物也核验共享上游的新鲜度，不把外部 locator 当自己的文件', async () => {
  const { Resources } = await import('../server/modules/data/resources.mjs');
  const value = Object.create(Resources.prototype), invalidated=[];
  value.scope={ownerId:'carol'};value.gate={permissionHub:{}};
  value.readable=async()=>{};value.query=async sql=>({rows:sql.includes('WITH RECURSIVE refs')?[{id:'source',owner_id:'bob',locator:'inputs/general/a.md'}]:[]});
  value.readShared=async source=>{assert.equal(source.owner_id,'bob');throw new Error('source changed');};
  value.files={read_file:()=>assert.fail('不能读取 carol 同名路径')};value.locked=operation=>operation({});value.invalidate=async id=>invalidated.push(id);
  await assert.rejects(value.refreshSources({id:'derived'}),e=>e.status===409);
  assert.deepEqual(invalidated,['source']);
});


test('Hub knowledge：basic 最多 3 个库；降级不删除，超额拒绝新增', async () => {
  const {hub,as,state}=hubFixture();
  const binding=id=>({sourceRoot:`inputs/${id}`,wikiRoot:`research/${id}/wiki`});
  for(const id of ['second','third']) await as('bob',()=>hub.registerKnowledge('bob',id,binding(id)));
  await assert.rejects(as('bob',()=>hub.registerKnowledge('bob','fourth',binding('fourth'))),e=>e.status===403);
  await as('alice',()=>hub.assign('bob','pro'));await as('bob',()=>hub.registerKnowledge('bob','fourth',binding('fourth')));
  await as('alice',()=>hub.assign('bob','basic'));assert.equal(state.knowledge.length,4);
  await assert.rejects(as('bob',()=>hub.registerKnowledge('bob','fifth',binding('fifth'))),e=>e.status===403);
});
