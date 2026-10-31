import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWorkbench} from '../server.mjs';
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-test-'));fs.mkdirSync(path.join(root,'.data'));const received=[];
 const upstream=createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);received.push({url:req.url,authorization:req.headers.authorization,origin:req.headers.origin,lastEventId:req.headers['last-event-id'],body:Buffer.concat(parts).toString()});
  if(req.url.startsWith('/events')){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"snapshot","threadId":"t"}\n\n');return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/health'?{status:'ready',model:'test-provider'}:{ok:true,route:req.url}));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const secret='server-only-test-token-1234567890';fs.writeFileSync(path.join(root,'.data/connection.json'),JSON.stringify({url:`http://127.0.0.1:${upstream.address().port}`,token:secret}));
 const app=createWorkbench({port:0,targets:[{id:'s05',root,live:true,name:'s05'}]});const url=await app.listen();
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
 const f=await fixture(t);assert.equal((await fetch(f.url+'/api/agent/s05/sessions')).status,401);
 assert.equal((await f.request('/api/agent/s05/messages',{text:'bad'},{origin:'https://evil.example'})).status,403);
 assert.equal((await f.request('/api/agent/s05/messages',{text:'bad'},{origin:''})).status,403);
 assert.equal((await f.request('/api/agent/s05/sessions',undefined,{'x-workbench':''})).status,403);
 const wrongHost=await new Promise((resolve,reject)=>{const req=httpRequest(f.url+'/api/bootstrap',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(wrongHost,403);assert.equal(f.received.length,0);
});
test('只代理固定目标和白名单接口，服务端附加令牌且不透传Origin',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/agent/unknown/messages',{})).status,404);assert.equal((await f.request('/api/agent/s05/admin/delete',{})).status,404);
 const r=await f.request('/api/agent/s05/messages',{threadId:'t',clientMessageId:'id',text:'hello'});assert.equal(r.status,200);
 for(const route of ['/tasks/confirm','/tasks/cancel'])assert.equal((await f.request('/api/agent/s05'+route,{threadId:'t',taskId:'id'})).status,200,route);assert.equal(f.received[0].origin,undefined);assert.equal(JSON.parse(f.received[0].body).clientMessageId,'id');
});
test('SSE保持事件帧；读取参数编码不被改写；断点编号只转发给事件流',async t=>{
 const f=await fixture(t);const r=await f.request('/api/agent/s05/events?threadId=t',undefined,{'last-event-id':'abcd1234-7'});assert.match(r.headers.get('content-type'),/text\/event-stream/);assert.match(await r.text(),/"snapshot"/);
 assert.equal(f.received.at(-1).lastEventId,'abcd1234-7');await f.request('/api/agent/s05/sessions',undefined,{'last-event-id':'abcd1234-7'});assert.equal(f.received.at(-1).lastEventId,undefined);
 await f.request('/api/agent/s05/workspace/read?path=inputs%2Fhello.md');assert.equal(f.received.at(-1).url,'/workspace/read?path=inputs%2Fhello.md');
});
test('服务离线明确返回503；连接文件不能把代理指向远端',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.root,'.data/connection.json'),JSON.stringify({url:'https://evil.example',token:f.secret}));
 assert.equal((await f.request('/api/agent/s05/sessions')).status,503);assert.equal(f.received.length,0);
});
test('静态服务不暴露状态、环境和课程brief；课程及工作台可读取',async t=>{
 const f=await fixture(t);for(const p of ['/.env','/.data/connection.json','/course/briefs/01.md','/app/%2e%2e/%2e%2e/package.json'])assert.equal((await fetch(f.url+p)).status,404,p);
 const r=await fetch(f.url+'/');assert.equal(r.status,200);assert.match(await r.text(),/Agent Atelier/);
 const shared=await fetch(f.url+'/app/session-events.js');assert.equal(shared.status,200);assert.match(shared.headers.get('content-type'),/javascript/);assert.match(await shared.text(),/export function applySessionEvent/);
});
