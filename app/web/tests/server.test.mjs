import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkbench} from '../server.mjs';
async function fixture(t,{optionalStatus=200,optionalBody={error:{message:'optional unavailable'}}}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-test-'));fs.mkdirSync(path.join(root,'.data'));const received=[];
 const upstream=createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);received.push({url:req.url,authorization:req.headers.authorization,origin:req.headers.origin,lastEventId:req.headers['last-event-id'],body:Buffer.concat(parts).toString()});
  if(['/tools','/memory'].includes(req.url)&&optionalStatus!==200){res.writeHead(optionalStatus,{'content-type':'application/json'});res.end(typeof optionalBody==='string'?optionalBody:JSON.stringify(optionalBody));return;}
  if(req.url.startsWith('/events')){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"snapshot","threadId":"t"}\n\n');return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/health'?{status:'ready',model:'test-provider'}:{ok:true,route:req.url}));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const secret='server-only-test-token-1234567890';fs.writeFileSync(path.join(root,'.data/connection.json'),JSON.stringify({url:`http://127.0.0.1:${upstream.address().port}`,token:secret}));
 const app=createWorkbench({port:0,targets:[{id:'s09',root,live:true,name:'s09'}]});const url=await app.listen();
 t.after(async()=>{await app.close();await new Promise(r=>{upstream.close(r);upstream.closeAllConnections();});fs.rmSync(root,{recursive:true,force:true});});
 const boot=await fetch(url+'/api/bootstrap');const cookie=boot.headers.get('set-cookie').split(';')[0];
 const request=(route,body,headers={})=>fetch(url+route,{method:body===undefined?'GET':'POST',headers:{cookie,'x-workbench':'1',...(body===undefined?{}:{origin:url,'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return{app,url,root,secret,received,cookie,request};
}
test('浏览器启动不暴露Agent凭据，Cookie受限，状态来自上游',async t=>{
 const f=await fixture(t);const r=await fetch(f.url+'/api/bootstrap');const txt=await r.text();assert.ok(!txt.includes(f.secret));assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Path=\/api/);
 const result=await f.request('/api/status');assert.equal((await result.json()).targets[0].status,'ready');assert.equal(f.received[0].authorization,`Bearer ${f.secret}`);
});
test('没有会话、跨Origin、缺少标识、错误Host均不能代理',async t=>{
 const f=await fixture(t);assert.equal((await fetch(f.url+'/api/agent/s09/sessions')).status,401);
 assert.equal((await f.request('/api/agent/s09/messages',{text:'bad'},{origin:'https://evil.example'})).status,403);
 assert.equal((await f.request('/api/agent/s09/messages',{text:'bad'},{origin:''})).status,403);
 assert.equal((await f.request('/api/agent/s09/sessions',undefined,{'x-workbench':''})).status,403);
 const wrongHost=await new Promise((resolve,reject)=>{const req=httpRequest(f.url+'/api/bootstrap',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(wrongHost,403);assert.equal(f.received.length,0);
});
test('只代理固定目标和白名单接口，服务端附加令牌且不透传Origin',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/agent/unknown/messages',{})).status,404);assert.equal((await f.request('/api/agent/s09/admin/delete',{})).status,404);
 const r=await f.request('/api/agent/s09/messages',{threadId:'t',clientMessageId:'id',text:'hello'});assert.equal(r.status,200);
 for(const route of ['/tasks/confirm','/tasks/cancel','/turns'])assert.equal((await f.request('/api/agent/s09'+route,{threadId:'t',taskId:'id'})).status,200,route);assert.equal(f.received[0].origin,undefined);assert.equal(JSON.parse(f.received[0].body).clientMessageId,'id');
});
test('SSE保持事件帧；读取参数编码不被改写；断点编号只转发给事件流',async t=>{
 const f=await fixture(t);const r=await f.request('/api/agent/s09/events?threadId=t',undefined,{'last-event-id':'abcd1234-7'});assert.match(r.headers.get('content-type'),/text\/event-stream/);assert.match(await r.text(),/"snapshot"/);
 assert.equal(f.received.at(-1).lastEventId,'abcd1234-7');await f.request('/api/agent/s09/sessions',undefined,{'last-event-id':'abcd1234-7'});assert.equal(f.received.at(-1).lastEventId,undefined);
 await f.request('/api/agent/s09/workspace/read?path=inputs%2Fhello.md');assert.equal(f.received.at(-1).url,'/workspace/read?path=inputs%2Fhello.md');
});
test('服务离线明确返回503；连接文件不能把代理指向远端',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.root,'.data/connection.json'),JSON.stringify({url:'https://evil.example',token:f.secret}));
 assert.equal((await f.request('/api/agent/s09/sessions')).status,503);assert.equal(f.received.length,0);
});
test('静态服务不暴露状态、环境和课程brief；课程及工作台可读取',async t=>{
 const f=await fixture(t);for(const p of ['/.env','/.data/connection.json','/course/briefs/01.md','/app/%2e%2e/%2e%2e/package.json'])assert.equal((await fetch(f.url+p)).status,404,p);
 const r=await fetch(f.url+'/');assert.equal(r.status,200);assert.match(await r.text(),/Agent Atelier/);
 const shared=await fetch(f.url+'/app/session-events.js');assert.equal(shared.status,200);assert.match(shared.headers.get('content-type'),/javascript/);assert.match(await shared.text(),/export function applySessionEvent/);
});

test('默认目标 id 与工作台前端的阶段键一致，旧 demoN 链接映射到对应目标', async () => {
  const { defaultTargets } = await import('../server.mjs');
  const main = fs.readFileSync(new URL('../public/app/main.js', import.meta.url), 'utf8');
  const keys = [...main.slice(main.indexOf('const stages={'), main.indexOf('};', main.indexOf('const stages={'))).matchAll(/^ (s\d\d):\{/gm)].map(m => m[1]);
  assert.deepEqual(defaultTargets.filter(t => t.id !== 'project').map(t => t.id), keys);
  assert.deepEqual(keys,Array.from({length:12},(_,num)=>`s${String(num).padStart(2,'0')}`));
  assert.match(main, /demo1:'s01',demo2:'s02',demo3:'s07',demo4:'s08',demo5:'s09'/);
  assert.deepEqual(defaultTargets.map(t=>t.port),[null,null,null,4313,4319,4323,4324,4325,4314,4315,4316,4318,4317]);
  for(const [num,target] of defaultTargets.entries()){
    assert.equal(target.live,num>=3,target.id);
    if(target.id!=='project')assert.match(path.basename(target.root),new RegExp(`^${target.id}-`));
    else assert.equal(path.basename(target.root),'app');
  }
});

test('可选快照保留成功数据；缺失/失败返回可用性数据，普通代理与权限检查不变',async t=>{
 for(const status of [200,404,401,403,503]){
  const error={message:'尚未核验 Codex 记忆配置。',code:'SERVER_ERROR',status};
  const f=await fixture(t,{optionalStatus:status,optionalBody:{error}});
  for(const endpoint of ['tools','memory']){
   const route='/api/agent/s09/'+endpoint;
   const response=await f.request(route,undefined,{'x-workbench-optional':'1'});
   assert.equal(response.status,200);
   const value=await response.json();
   if(status===200)assert.equal(value.route,'/'+endpoint);
   else{assert.deepEqual(value,{available:false,error});}
   assert.equal((await f.request(route)).status,status,'未标记的代理保留 HTTP 状态');
  }
  assert.equal((await fetch(f.url+'/api/agent/s09/tools',{headers:{'x-workbench-optional':'1'}})).status,401);
  assert.equal((await f.request('/api/agent/s09/admin',undefined,{'x-workbench-optional':'1'})).status,404);
 }
});

// Exercise the actual HTTP handler without binding a port; usable in restricted sandboxes.
async function memoryProxy(t,{status,body}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-handler-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'.data'));
 fs.writeFileSync(path.join(root,'.data/connection.json'),JSON.stringify({url:'http://127.0.0.1:4317',token:'test-only-connection-token'}));
 const app=createWorkbench({port:4320,targets:[{id:'s09',root,live:true}]});
 t.mock.method(app.server,'listen',(_port,_host,ready)=>ready());t.mock.method(app.server,'address',()=>({port:4320}));await app.listen();
 t.mock.method(globalThis,'fetch',async url=>new Response(url.endsWith('/sessions')?'{}':typeof body==='string'?body:JSON.stringify(body),{status:url.endsWith('/sessions')?200:status}));
 let cookie;
 const request=(route,_body,headers={})=>new Promise(resolve=>{
  const res=new EventEmitter(),responseHeaders={};
  res.setHeader=(key,value)=>responseHeaders[key]=value;
  res.writeHead=(status)=>{res.status=status;res.headersSent=true;};
  res.end=text=>resolve({status:res.status,headers:responseHeaders,json:async()=>JSON.parse(text)});
  app.server.emit('request',{url:route,method:'GET',headers:{host:'127.0.0.1:4320',cookie,'x-workbench':'1',...headers}},res);
 });
 cookie=(await request('/api/bootstrap')).headers['set-cookie'].split(';')[0];
 return {request};
}

for(const status of [404,401,403,503])test(`第三轮 P2-1：可选接口 ${status} 保留上游诊断 message/code/status`,async t=>{
 const error={message:status===503?'尚未核验 Codex 记忆配置。':'上游诊断 <img src=x onerror=alert(1)>',code:'MEMORY_UNVERIFIED',status};
 const f=await memoryProxy(t,{status,body:{error:{...error,stack:'private stack'},internal:'private data'}});
 for(const endpoint of ['tools','memory']){
  const response=await f.request('/api/agent/s09/'+endpoint,undefined,{'x-workbench-optional':'1'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{available:false,error});
 }
 assert.equal((await f.request('/api/agent/s09/sessions')).status,200);
});

for(const [label,status,body,expected] of [
 ['真实 memory 错误体不带 status',503,{error:{message:'尚未核验 Codex 记忆配置。',code:'SERVER_ERROR'}},{status:503,message:'尚未核验 Codex 记忆配置。',code:'SERVER_ERROR'}],
 ['JSON 不含公开错误',403,{internal:'private'}, {status:403,message:'上游请求失败（HTTP 403）'}],
 ['非 JSON 404',404,'<html>private</html>',{status:404,message:'当前目标未提供此接口'}],
 ['非 JSON 503',503,'upstream unavailable',{status:503,message:'上游请求失败（HTTP 503）'}],
 ['错误字段形状无效',503,{error:{message:{private:true},code:{private:true},status:'bad'}},{status:503,message:'上游请求失败（HTTP 503）'}],
 ['成功状态却返回无效 JSON',200,'invalid json',{status:502,message:'接口返回了无效数据'}]
])test(`第三轮 P2-1：${label} 使用安全兜底`,async t=>{
 const f=await memoryProxy(t,{status,body});
 const response=await f.request('/api/agent/s09/memory',undefined,{'x-workbench-optional':'1'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{available:false,error:expected});
});

function withPublicOrigin(value){
 const previous=process.env.WORKBENCH_PUBLIC_ORIGIN;
 if(value===undefined)delete process.env.WORKBENCH_PUBLIC_ORIGIN;
 else process.env.WORKBENCH_PUBLIC_ORIGIN=value;
 return ()=>{if(previous===undefined)delete process.env.WORKBENCH_PUBLIC_ORIGIN;else process.env.WORKBENCH_PUBLIC_ORIGIN=previous;};
}
async function hosted(t,publicOrigin){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-public-'));fs.mkdirSync(path.join(root,'.data'));const received=[];
 const upstream=createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);received.push({url:req.url,authorization:req.headers.authorization,origin:req.headers.origin,body:Buffer.concat(parts).toString()});
  res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/health'?{status:'ready'}:{ok:true,route:req.url}));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const secret='server-only-test-token-1234567890';fs.writeFileSync(path.join(root,'.data/connection.json'),JSON.stringify({url:`http://127.0.0.1:${upstream.address().port}`,token:secret}));
 let app;t.after(async()=>{if(app)await app.close();await new Promise(r=>{upstream.close(r);upstream.closeAllConnections();});fs.rmSync(root,{recursive:true,force:true});});
 const restore=withPublicOrigin(publicOrigin);
 try{app=createWorkbench({port:0,targets:[{id:'s09',root,live:true,name:'s09'}]});}
 finally{restore();}
 const url=await app.listen();
 const call=(route,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=httpRequest(url+route,{method,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const setCookie=res.headers['set-cookie'];const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,setCookie:Array.isArray(setCookie)?setCookie[0]:setCookie,text,json:()=>JSON.parse(text)});});});req.on('error',reject);req.end(body);});
 return{url,secret,received,call};
}

test('WORKBENCH_PUBLIC_ORIGIN 非法值拒绝启动，空值和带端口的规范 Origin 可以启动',()=>{
 const restore=withPublicOrigin(undefined);
 try{
  for(const value of ['http://codexharness.cleverless.cn','https://codexharness.cleverless.cn/','https://codexharness.cleverless.cn/workbench','https://codexharness.cleverless.cn?next=/','https://user@codexharness.cleverless.cn','https://user:secret@codexharness.cleverless.cn','HTTPS://codexharness.cleverless.cn','https://codexharness.cleverless.cn#session','https://codexharness.cleverless.cn:8443/path']){
   process.env.WORKBENCH_PUBLIC_ORIGIN=value;
   assert.throws(()=>createWorkbench({port:0,targets:[]}),/WORKBENCH_PUBLIC_ORIGIN/,value);
  }
  for(const value of ['','https://codexharness.cleverless.cn','https://codexharness.cleverless.cn:8443','https://codexharness.cleverless.cn:443']){
   process.env.WORKBENCH_PUBLIC_ORIGIN=value;
   try{createWorkbench({port:0,targets:[]});}catch(error){throw Error(`${JSON.stringify(value)} 应允许启动：${error.message}`);}
  }
 }finally{restore();}
});

for(const origin of ['https://codexharness.cleverless.cn','https://codexharness.cleverless.cn:8443'])test(`设置 ${origin} 后公开 Host 与正确 Origin 可用，错误 Origin 和未知 Host 被拒，Cookie 带 Secure`,async t=>{
 const host=origin.slice('https://'.length);const f=await hosted(t,origin);
 const boot=await f.call('/api/bootstrap',{headers:{host,origin}});
 assert.equal(boot.status,200);assert.match(boot.setCookie,/^workbench_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=28800; Secure$/);
 const cookie=boot.setCookie.split(';')[0];
 const read=await f.call('/api/agent/s09/sessions',{headers:{host,origin,cookie,'x-workbench':'1'}});
 assert.equal(read.status,200);
 const write=await f.call('/api/agent/s09/messages',{method:'POST',headers:{host,origin,cookie,'x-workbench':'1','content-type':'application/json'},body:JSON.stringify({text:'hello'})});
 assert.equal(write.status,200);assert.equal(f.received.at(-1).origin,undefined);assert.equal(f.received.at(-1).authorization,`Bearer ${f.secret}`);
 assert.equal((await f.call('/api/agent/s09/sessions',{headers:{host,origin:'https://evil.example',cookie,'x-workbench':'1'}})).status,403);
 assert.equal((await f.call('/api/agent/s09/messages',{method:'POST',headers:{host,origin:`http://${host}`,cookie,'x-workbench':'1','content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await f.call('/api/bootstrap',{headers:{host:'evil.example'}})).status,403);
 const local=await fetch(f.url+'/api/bootstrap');assert.equal(local.status,200);
 assert.match(local.headers.get('set-cookie'),/^workbench_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=28800$/);
 const localCookie=local.headers.get('set-cookie').split(';')[0];const localHost=new URL(f.url).host;
 assert.equal((await f.call('/api/agent/s09/messages',{method:'POST',headers:{host:localHost,origin:f.url,cookie:localCookie,'x-workbench':'1','content-type':'application/json'},body:'{"text":"ok"}'})).status,200);
 assert.equal((await f.call('/api/agent/s09/messages',{method:'POST',headers:{host:localHost,origin,cookie:localCookie,'x-workbench':'1','content-type':'application/json'},body:'{}'})).status,403);
});

for(const value of [undefined,''])test(`WORKBENCH_PUBLIC_ORIGIN ${value===undefined?'未设置':'为空'} 时公开 Host 被拒`,async t=>{
 const f=await hosted(t,value);
 assert.equal((await f.call('/api/bootstrap',{headers:{host:'codexharness.cleverless.cn'}})).status,403);
 const local=await fetch(f.url+'/api/bootstrap');
 assert.equal(local.status,200);assert.doesNotMatch(local.headers.get('set-cookie'),/Secure/);
});
