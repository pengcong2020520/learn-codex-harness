import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkbench} from '../server.mjs';

// Exercise the real handler without opening a port, including its cookie checks.
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-status-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'.data'));
 const secret='private-status-token-1234567890',file=path.join(root,'.data/connection.json');
 const app=createWorkbench({port:4320,targets:[{id:'s09',root,live:true},{id:'s01',root,live:false}]});
 t.mock.method(app.server,'listen',(_port,_host,ready)=>ready());t.mock.method(app.server,'address',()=>({port:4320}));await app.listen();
 let cookie;
 const request=(route,headers={})=>new Promise(resolve=>{
  const res=new EventEmitter(),responseHeaders={};
  res.setHeader=(key,value)=>responseHeaders[key]=value;
  res.writeHead=status=>{res.status=status;res.headersSent=true;};
  res.end=text=>resolve({status:res.status,headers:responseHeaders,body:JSON.parse(text),text});
  app.server.emit('request',{url:route,method:'GET',headers:{host:'127.0.0.1:4320',cookie,'x-workbench':'1',...headers}},res);
 });
 cookie=(await request('/api/bootstrap')).headers['set-cookie'].split(';')[0];
 return {root,secret,file,request,connect(){fs.writeFileSync(file,JSON.stringify({url:'http://127.0.0.1:4317',token:secret}));}};
}
function privateFree(response,f){
 assert.equal(response.status,200);
 for(const value of [f.root,f.file,f.secret,'connection.json','127.0.0.1:4317'])assert.ok(!response.text.includes(value),`泄露 ${value}`);
 assert.deepEqual(response.body.targets[1],{id:'s01',status:'cli'});
 return response.body.targets[0];
}

for(const httpStatus of [200,503])for(const diagnostic of [
 'source=</Users/alice/private.log>',
 'relation "private_customer_ledger" does not exist',
 'connect ECONNREFUSED 10.24.8.19:5432'
])test(`公开原因白名单：HTTP ${httpStatus} 不返回 ${diagnostic}`,async t=>{
 const f=await fixture(t);f.connect();
 for(const field of ['error','tools','message']){
  const body={status:'degraded',...(field==='error'?{error:{message:diagnostic,code:diagnostic}}:field==='tools'?{tools:{error:diagnostic}}:{message:diagnostic})};
  t.mock.method(globalThis,'fetch',async()=>Response.json(body,{status:httpStatus}));
  const response=await f.request('/api/status');
  assert.ok(!JSON.stringify(response.body).includes(JSON.stringify(diagnostic).slice(1,-1)),response.text);
  assert.deepEqual(privateFree(response,f),{id:'s09',status:'degraded',reason:'degraded',code:'AGENT_DEGRADED',message:'Agent 服务暂不可用，请检查服务端。'});
 }
});

test('status reason：缺失连接文件为 not-started，读取/解析失败为 unreachable，不暴露路径或令牌',async t=>{
 const f=await fixture(t);
 t.mock.method(globalThis,'fetch',async()=>assert.fail('连接文件不可用时不应请求上游'));
 let result=privateFree(await f.request('/api/status'),f);
 assert.equal(result.status,'offline');assert.equal(result.reason,'not-started');
 for(const invalid of ['invalid json',JSON.stringify({url:'https://evil.example',token:f.secret})]){
  fs.writeFileSync(f.file,invalid);result=privateFree(await f.request('/api/status'),f);
  assert.equal(result.status,'offline');assert.equal(result.reason,'unreachable');assert.match(result.message,/连接信息/);
 }
});

for(const failure of ['network','invalid-json'])test(`status reason：${failure} 为 unreachable 且不透传异常`,async t=>{
 const f=await fixture(t);f.connect();
 t.mock.method(globalThis,'fetch',async()=>{if(failure==='network')throw Error(`${f.root} ${f.secret}`);return new Response(`${f.root} ${f.secret}`);});
 const result=privateFree(await f.request('/api/status'),f);
 assert.equal(result.status,'offline');assert.equal(result.reason,'unreachable');assert.match(result.message,/无法连接 Agent/);
});

for(const httpStatus of [200,503])test(`status reason：HTTP ${httpStatus} 非白名单诊断与元数据全部省略`,async t=>{
 const f=await fixture(t);f.connect();
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  assert.equal(init.headers.authorization,`Bearer ${f.secret}`);
  return Response.json({status:'degraded',error:{message:`Codex 连接已失效 <b>诊断</b> ${f.file} ${f.secret} /Users/example/private.log C:\\private\\log.txt`,stack:'private stack'},model:f.secret,queueBackend:f.root,internal:'private internal'},{status:httpStatus});
 });
 const response=await f.request('/api/status'),result=privateFree(response,f);
 assert.deepEqual(result,{id:'s09',status:'degraded',reason:'degraded',code:'AGENT_DEGRADED',message:'Agent 服务暂不可用，请检查服务端。'});
 assert.doesNotMatch(response.text,/private stack|private internal|Users\/example|private\\/);
});

test('status reason：非 JSON 错误响应仍为 degraded，成功状态不携带失败原因',async t=>{
 const f=await fixture(t);f.connect();let healthy=false;
 t.mock.method(globalThis,'fetch',async()=>healthy?Response.json({status:'ready',model:'openai/test-model',queueBackend:'redis'}):new Response('private diagnostic',{status:502}));
 const failed=privateFree(await f.request('/api/status'),f);
 assert.equal(failed.reason,'degraded');assert.equal(failed.code,'AGENT_DEGRADED');assert.equal(failed.message,'Agent 服务暂不可用，请检查服务端。');
 healthy=true;
 assert.deepEqual(privateFree(await f.request('/api/status'),f),{id:'s09',status:'ready',model:'openai/test-model',queueBackend:'redis'});
});

test('公开原因白名单：只认可精确提示或允许的错误码，不拼接上游文本',async t=>{
 const f=await fixture(t);f.connect();
 const message='Codex 连接已失效，请重启服务并核对任务状态。';
 const legacy='Codex 连接已失效，请重启服务并核对会话状态。';
 for(const body of [
  {error:{message}}, {error:{message:legacy}}, {tools:{error:message}}, {message},
  {error:{code:'CODEX_CONNECTION_LOST',message:'source=</Users/alice/private.log>'}}
 ]){
  t.mock.method(globalThis,'fetch',async()=>Response.json({status:'degraded',...body}));
  assert.deepEqual(privateFree(await f.request('/api/status'),f),{id:'s09',status:'degraded',reason:'degraded',code:'CODEX_CONNECTION_LOST',message});
 }
 for(const body of [
  {error:{message:message+' source=</Users/alice/private.log>'}},
  {error:{message:'prefix '+message}},
  {error:{message:message+'\n'}},
  {error:{message,code:'UNKNOWN_INTERNAL_CODE'}},
  {error:{code:'toString'}}, {error:{code:'__proto__'}},
  {error:{code:{name:'CODEX_CONNECTION_LOST'}}},
  {error:{code:'AGENT_DEGRADED',message:'relation "private_customer_ledger" does not exist'}},
  {error:{message:['source=</Users/alice/private.log>']}},
  {error:{message:{detail:'connect ECONNREFUSED 10.24.8.19:5432'}}},
  {model:'source=</Users/alice/private.log>',queueBackend:'private_customer_ledger',internal:'connect ECONNREFUSED 10.24.8.19:5432'},
  {}
 ]){
  t.mock.method(globalThis,'fetch',async()=>Response.json({status:'degraded',...body}));
  assert.deepEqual(privateFree(await f.request('/api/status'),f),{id:'s09',status:'degraded',reason:'degraded',code:'AGENT_DEGRADED',message:'Agent 服务暂不可用，请检查服务端。'});
 }
});

test('status：失效的工作台会话返回可识别错误，不检查 Agent',async t=>{
 const f=await fixture(t);
 t.mock.method(globalThis,'fetch',async()=>assert.fail('会话过期不应请求上游'));
 const response=await f.request('/api/status',{cookie:`workbench_session=${'a'.repeat(64)}`});
 assert.equal(response.status,401);
 assert.deepEqual(response.body,{error:{message:'工作台会话已过期，请刷新页面。',code:'WORKBENCH_SESSION_EXPIRED'}});
 assert.ok(!response.text.includes(f.root));assert.ok(!response.text.includes(f.secret));
});
