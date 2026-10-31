// Local browser QA fixture. No production data or external model calls.
import {createServer} from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWorkbench} from '../server.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-ui-fixture-'));
fs.mkdirSync(path.join(root,'.data'));
const threads=[], queues=new Map(), sources=new Map(), pages=new Map();let id=0;
const upstream=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');let body={};if(req.method==='POST'){const chunks=[];for await(const c of req)chunks.push(c);body=JSON.parse(Buffer.concat(chunks));}
  const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const session=()=>threads.find(t=>t.id===(body.threadId||url.searchParams.get('threadId')));
  switch(url.pathname){
    case '/health':return send({model:'local-ui-fixture',queueBackend:'postgres'});
    case '/workbench':return send({agent:{id:'ui-fixture',version:'1.0',tools:{allow:['read_file','kb_read','kb_submit_revision']},memory:{use:false,contribute:false}},queueBackend:'postgres'});
    case '/sessions':if(req.method==='GET')return send({sessions:threads});{const t={id:'fixture-thread-'+(++id),name:'浏览器测试会话',turns:[]};threads.push(t);queues.set(t.id,{threadId:t.id,paused:false,jobs:[]});return send(t);}
    case '/sessions/resume':return send(session());
    case '/messages':{const t=session();if(!t)return send({error:{message:'会话不存在'}},404);const knowledge=body.knowledge;const turn={id:'fixture-turn-'+(++id),status:'completed',messages:[{id:body.clientMessageId,text:body.text}],answers:{a:knowledge?'测试模型：Wiki 已整理为 services。':'测试模型：收到任务。'},tools:{}};t.turns.push(turn);queues.get(t.id).jobs.push({id:body.clientMessageId,text:body.text,status:'completed',turnId:turn.id});if(knowledge)pages.set('services',{slug:'services',content:'# 测试服务\n这是浏览器联调测试的 Wiki。',versionId:'fixture-wiki-v1',source_versions:[{resourceId:'fixture-resource',versionId:'fixture-source-v1'}]});return send({id:body.clientMessageId,status:'completed'});}
    case '/state':return send({session:session(),queue:queues.get(session()?.id)});
    case '/events':res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({type:'snapshot',data:{session:session(),queue:queues.get(session()?.id)}})}\n\n`);return;
    case '/knowledge':return send({knowledge:[{kbId:'general',desiredMode:'wiki',effectiveMode:'wiki',actions:['read','update','index']}]});
    case '/knowledge/pages':return send({kbId:'general',pages:[...pages.values()],truncated:false});
    case '/knowledge/read':return send(pages.get(url.searchParams.get('slug')));
    case '/knowledge/search':return send({mode:'wiki',hits:[...pages.values()]});
    case '/knowledge/source':if(sources.has(body.name))return send({error:{message:'同名原文已存在，请更换文件名；未覆盖。'}},409);sources.set(body.name,body.content);return send({path:'inputs/general/'+body.name,resourceId:'fixture-resource',versionId:'fixture-source-v1'});
    case '/workspace':return send({path:url.searchParams.get('path'),entries:[...sources.keys()].map(name=>({name,type:'file',bytes:100}))});
    case '/workspace/read':return send({path:url.searchParams.get('path'),content:[...sources.values()][0],resourceId:'fixture-resource',versionId:'fixture-source-v1'});
    case '/knowledge/index':return send({jobId:'fixture-index',status:'queued'});
    case '/knowledge/job':return send({id:'fixture-index',state:'completed'});
    default:return send({error:{message:'fixture route missing'}},404);
  }
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
fs.writeFileSync(path.join(root,'.data/connection.json'),JSON.stringify({url:`http://127.0.0.1:${upstream.address().port}`,token:'fixture-only-no-real-credentials'}));
const bridge=createWorkbench({port:4321,targets:[{id:'s05',root,live:true,name:'UI fixture'}]});
console.log(await bridge.listen());
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(root,{recursive:true,force:true});process.exit(0);});
