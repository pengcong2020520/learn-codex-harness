import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, migrate } from '../../stages/s11-model-gateway/server/modules/data/database.mjs';
import { tempRoot, cleanup, installToolFixture, until } from '../../stages/s11-model-gateway/tests/helpers.mjs';
import { startAgentServer } from '../../stages/s11-model-gateway/server/main.mjs';
import { loadServerConfig } from '../../stages/s11-model-gateway/server/modules/config/index.mjs';
import { responsesFixture, answer, toolCall, toolSpecs } from '../../stages/s11-model-gateway/tests/responses-fixture.mjs';
const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;

test('真实 Codex + PG + Redis：动态工具任务身份、维护范围持久化、Wiki 生成与读取闭环', {timeout:60000}, async t=>{
  const root=installToolFixture(tempRoot(t),{knowledge:true});
  fs.mkdirSync(path.join(root,'workspace/inputs/general'),{recursive:true});
  fs.writeFileSync(path.join(root,'workspace/inputs/general/source.md'),'# 原始事实\n门店有三种服务。');
  const pool=await openDatabase(databaseUrl); await migrate(pool); await pool.end();
  let step=0, refs;
  const provider=await responsesFixture(root,body=>{
    assert.ok(JSON.stringify(body).includes('普通对话没有维护权限时'), '原生知识 Skill 没有注入');
    assert.ok(JSON.stringify(body).includes('可以更新知识库 general'), 'workflow 任务说明没有进入模型请求');
    const specs=toolSpecs(body);
    assert.ok(specs.some(s=>s.name==='kb_submit_revision'));
    assert.ok(!specs.some(s=>s.name?.startsWith('mcp__')));
    const outputs=(body.input||[]).filter(i=>i.type==='function_call_output').map(i=>{try{return JSON.parse(typeof i.output==='string'?i.output: i.output?.[0]?.text)}catch{return null}}).filter(Boolean);
    const source=outputs.find(v=>v.resourceId&&v.versionId);
    if(source) refs=[{resourceId:source.resourceId,versionId:source.versionId}];
    const actions=[['read_file',{path:'inputs/general/source.md'}],['kb_submit_revision',{kbId:'general',slug:'services',content:'# 服务\n门店有三种服务。',expectedVersion:null,source_versions:refs}],['kb_read',{kbId:'general',slug:'services'}],null];
    const action=actions[step++];
    if(!action) return answer('知识维护完成。');
    if(action[0]==='kb_submit_revision') {assert.ok(refs,JSON.stringify(outputs));action[1].source_versions=refs;}
    return toolCall(specs.find(s=>s.name===action[0]),action[1]);
  });
  const config=loadServerConfig(root,{CODEX_API_KEY:'local-test-only',CODEX_BASE_URL:provider.url,CODEX_MODEL:'local-test-model',CODEX_MODEL_CATALOG_ENABLED:'true',CODEX_MODEL_CONTEXT_WINDOW:'128000',DEMO_TIMEOUT_MS:'15000',DATABASE_URL:databaseUrl,REDIS_URL:redisUrl});config.port=0;
  const app=await startAgentServer({config,log:()=>{}});cleanup(root,()=>app.close());
  const { createWorkbench }=await import('../web/server.mjs');
  const bridge=createWorkbench({port:0,targets:[{id:'s09',root,live:true,name:'test'}]});const bridgeUrl=await bridge.listen();cleanup(root,()=>bridge.close());
  const boot=await fetch(bridgeUrl+'/api/bootstrap'),cookie=boot.headers.get('set-cookie').split(';')[0];
  const web=async(route,body)=>{const response=await fetch(bridgeUrl+'/api/agent/s09'+route,{method:body===undefined?'GET':'POST',headers:{cookie,'x-workbench':'1',...(body===undefined?{}:{origin:bridgeUrl,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  assert.equal((await web('/workbench')).agent.id,app.agent.definition.agent.id);
  const imported=await web('/knowledge/source',{kbId:'general',name:'web-import.md',content:'# Web 导入\n来自工作台的原文。'});
  assert.ok(imported.versionId);assert.equal((await web('/workspace/read?path=inputs%2Fgeneral%2Fweb-import.md')).versionId,imported.versionId);
  const session=await web('/sessions',{});
  await web('/messages',{threadId:session.id,clientMessageId:'maintain',text:'维护知识库',workflow:'knowledge-maintain',params:{kbId:'general'}});
  await until(async()=>['completed','failed','unconfirmed'].includes((await app.messages.job('maintain')).status),25000);
  assert.equal((await app.messages.job('maintain')).status,'completed');assert.deepEqual(provider.errors,[]);
  const result=await app.gate.run(app.gate.operator(),()=>app.knowledge.read({kbId:'general',slug:'services'}));assert.match(result.content,/三种/);
  const job=await app.messages.job('maintain');
  assert.equal(job.workflow,'knowledge-maintain');assert.deepEqual(job.params,{kbId:'general'});
  assert.deepEqual(job.checks.map(c=>[c.id,c.passed]),[['wiki-effective',true]],'维护任务的 Wiki 修订应通过验收');
  assert.equal((await web('/knowledge/pages?kbId=general')).pages[0].slug,'services');
  assert.match((await web('/knowledge/read?kbId=general&slug=services')).content,/三种/);
  assert.equal(app.gate.runs.size,0);
  const direct=await app.tools.registry.call({tool:'read_file',arguments:{path:'inputs/general/source.md'}});assert.equal(direct.success,false);
});
test('真实 Codex + PG + Redis：普通对话不能维护知识库，只能提议；用户确认后按 workflow 授权执行并验收', {timeout:60000}, async t=>{
  const root=installToolFixture(tempRoot(t),{knowledge:true});
  fs.mkdirSync(path.join(root,'workspace/inputs/general'),{recursive:true});
  fs.writeFileSync(path.join(root,'workspace/inputs/general/source.md'),'# 原始事实\n门店有三种服务。');
  const pool=await openDatabase(databaseUrl); await migrate(pool); await pool.end();
  let phase='chat', step=0, refs, denied, instructions;
  const provider=await responsesFixture(root,body=>{
    const specs=toolSpecs(body), call=(name,args)=>toolCall(specs.find(s=>s.name===name),args);
    const outputs=(body.input||[]).filter(i=>i.type==='function_call_output').map(i=>{try{return JSON.parse(typeof i.output==='string'?i.output:i.output?.[0]?.text)}catch{return null}}).filter(Boolean);
    const source=outputs.find(v=>v.resourceId&&v.versionId); if(source) refs=[{resourceId:source.resourceId,versionId:source.versionId}];
    const revision=()=>call('kb_submit_revision',{kbId:'general',slug:'services',content:'# 服务\n门店有三种服务。',expectedVersion:null,source_versions:refs});
    if(phase==='chat'){
      instructions??=JSON.stringify(body);
      const actions=[()=>call('read_file',{path:'inputs/general/source.md'}),revision,
        ()=>{denied=outputs.at(-1);return call('propose_task',{workflow:'knowledge-maintain',params:{kbId:'general'},text:'把 inputs/general 的资料整理成 services 页面',reason:'普通对话没有维护知识库的授权'});},
        ()=>answer('已提议知识维护，等待你确认。')];
      return actions[step++]();
    }
    return [()=>call('read_file',{path:'inputs/general/source.md'}),revision,()=>answer('知识维护完成。')][step++]();
  });
  const config=loadServerConfig(root,{CODEX_API_KEY:'local-test-only',CODEX_BASE_URL:provider.url,CODEX_MODEL:'local-test-model',CODEX_MODEL_CATALOG_ENABLED:'true',CODEX_MODEL_CONTEXT_WINDOW:'128000',DEMO_TIMEOUT_MS:'15000',DATABASE_URL:databaseUrl,REDIS_URL:redisUrl});config.port=0;
  const app=await startAgentServer({config,log:()=>{}});cleanup(root,()=>app.close());
  const { createWorkbench }=await import('../web/server.mjs');
  const bridge=createWorkbench({port:0,targets:[{id:'s11',root,live:true,name:'test'}]});const bridgeUrl=await bridge.listen();cleanup(root,()=>bridge.close());
  const cookie=(await fetch(bridgeUrl+'/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const web=async(route,body)=>{const response=await fetch(bridgeUrl+'/api/agent/s11'+route,{method:body===undefined?'GET':'POST',headers:{cookie,'x-workbench':'1',...(body===undefined?{}:{origin:bridgeUrl,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const session=await web('/sessions',{});
  await web('/messages',{threadId:session.id,clientMessageId:'chat',text:'把新资料更新到知识库'});
  await until(async()=>['completed','failed','unconfirmed'].includes((await app.messages.job('chat')).status),25000);
  assert.equal((await app.messages.job('chat')).status,'completed');
  assert.match(instructions,/用 propose_task 向用户提议/);
  assert.match(JSON.stringify(denied),/未授权/,'普通对话直接提交 Wiki 修订必须被权限门拒绝');
  const proposal=(await web('/state?threadId='+session.id)).queue.jobs.find(job=>job.status==='proposed');
  assert.deepEqual([proposal.workflow,proposal.params,proposal.reason],['knowledge-maintain',{kbId:'general'},'普通对话没有维护知识库的授权']);
  await assert.rejects(app.gate.run(app.gate.operator(),()=>app.knowledge.read({kbId:'general',slug:'services'})),'提议本身不改动知识库');
  phase='maintain';step=0;
  await web('/tasks/confirm',{threadId:session.id,taskId:proposal.id});
  await until(async()=>['completed','needs-review','failed','unconfirmed'].includes((await app.messages.job(proposal.id)).status),25000);
  const done=await app.messages.job(proposal.id);
  assert.equal(done.status,'completed',JSON.stringify(done));
  assert.deepEqual(done.checks.map(c=>[c.id,c.passed]),[['wiki-effective',true]]);
  assert.match((await app.gate.run(app.gate.operator(),()=>app.knowledge.read({kbId:'general',slug:'services'}))).content,/三种/);
  assert.deepEqual(provider.errors,[]);
});

