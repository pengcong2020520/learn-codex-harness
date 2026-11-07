import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';

const options={skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'};
async function setup(t,{expired=false,view='run',stage='s09',ready=false,legacy=false}={}){
 const app=createWorkbench({port:0,targets:[]});const url=await app.listen();t.after(()=>app.close());
 const b=await browser(t);
 await b.beforeLoad(`
  window.fixture={expired:${expired},calls:0,polls:0,pending:false,result:${JSON.stringify(ready?{status:'ready'}:{status:'offline',reason:'not-started'})}};
  const nativeFetch=window.fetch;
  window.fetch=async(input,init)=>{
   const route=new URL(String(input),location.href).pathname;
   const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
   if(route==='/api/status'){
    fixture.calls++;
    if(fixture.pending)await new Promise(resolve=>fixture.release=resolve);
    if(fixture.expired)return json({error:{message:'工作台会话已过期，请刷新页面。',code:'WORKBENCH_SESSION_EXPIRED'}},401);
    return json({targets:[{id:${JSON.stringify(stage)},...fixture.result}]});
   }
   if(route.endsWith('/sessions'))return json(init?.method==='POST'?{id:'poll-thread',turns:[]}:{sessions:[]});
   if(route.endsWith('/state')){
    fixture.polls++;
    if(fixture.expired)return json({error:{message:'工作台会话已过期，请刷新页面。',...(${legacy}?{}:{code:'WORKBENCH_SESSION_EXPIRED'})}},401);
    return json({session:{id:'poll-thread',turns:[]}});
   }
   return nativeFetch(input,init);
  };`);
 await b.open(`${url}/?stage=${stage}&view=${view}`);
 await b.run(`${helpers}if(!await until(()=>fixture.calls===1&&$('.stage.active')))throw Error('页面未就绪');await sleep(100);`);
 return b;
}

test('重新连接：未启动提示包含阶段、命令、依赖与检查时间，检查期间禁用并防止重复请求',options,async t=>{
 const b=await setup(t);
 const pending=await b.run(`${helpers}
  fixture.pending=true;$('[data-action="reconnect"]').click();
  if(!await until(()=>fixture.release))throw Error('未发起检查');
  const button=$('[data-action="reconnect"]');button.click();
  return {disabled:button.disabled,label:button.textContent,calls:fixture.calls};`);
 assert.deepEqual(pending,{disabled:true,label:'正在检查…',calls:2});
 const result=await b.run(`${helpers}
  fixture.release();
  if(!await until(()=>$('.connection-result time')&&!$('[data-action="reconnect"]').disabled))throw Error('检查未完成');
  return {message:$('.connection-result').textContent,time:$('.connection-result time').dateTime,command:$('.terminal').textContent};`);
 assert.match(result.message,/没有检测到 s09 的 Agent 服务/);
 assert.match(result.message,/stages\/s09-knowledge-layer 运行 npm run server/);
 assert.match(result.message,/PostgreSQL \/ Redis/);assert.match(result.message,/检查时间：\d{2}:\d{2}:\d{2}/);
 assert.ok(Number.isFinite(Date.parse(result.time)));assert.match(result.command,/cd stages\/s09-knowledge-layer[\s\S]*npm run server/);
});

for(const legacy of [false,true])test(`会话过期：s03 轮询显示刷新提示、停止请求并可恢复（旧服务 ${legacy}）`,options,async t=>{
 const b=await setup(t,{stage:'s03',ready:true,legacy});
 await b.run(`${helpers}
  if(!$('#composer'))throw Error('初始输入界面未显示');
  $('[data-action="new-thread"]').click();
  if(!await until(()=>fixture.polls===1))throw Error('未开始轮询');
  fixture.expired=true;`);
 const result=await b.run(`${helpers}
  if(!await until(()=>$('[data-action="reload"]')))throw Error('轮询过期后缺少刷新入口');
  const polls=fixture.polls;await sleep(1200);
  return {message:$('.connection-result').textContent,composer:Boolean($('#composer')),reconnect:Boolean($('[data-action="reconnect"]')),polls,after:fixture.polls};`);
 assert.match(result.message,/本地工作台已重启，请刷新页面/);
 assert.equal(result.composer,false);assert.equal(result.reconnect,false);assert.equal(result.polls,2);assert.equal(result.after,2);
 await b.clickNavigate('[data-action="reload"]');
 assert.equal(await b.run(`${helpers}return await until(()=>$('#composer')&&!$('[data-action="reload"]'));`),true);
});

for(const initial of [true,false])test(`会话过期：${initial?'页面加载':'重新连接'}显示刷新提示且可刷新恢复`,options,async t=>{
 const b=await setup(t,{expired:initial,view:initial?'learn':'run'});
 if(!initial)await b.run(`${helpers}fixture.expired=true;$('[data-action="reconnect"]').click();`);
 const result=await b.run(`${helpers}
  if(!await until(()=>$('[data-action="reload"]')))throw Error('缺少刷新入口');
  return {message:$('.connection-result').textContent,label:$('[data-action="reload"]').textContent,reconnect:Boolean($('[data-action="reconnect"]'))};`);
 assert.match(result.message,/本地工作台已重启，请刷新页面/);assert.equal(result.label,'刷新页面');assert.equal(result.reconnect,false);
 // The script runs on each new document; remove the injected expiry for the reload.
 await b.beforeLoad('fixture.expired=false;');
 await b.clickNavigate('[data-action="reload"]');
 assert.equal(await b.run(`${helpers}await until(()=>fixture.calls===1);await sleep(100);return Boolean($('[data-action="reload"]'));`),false);
});

test('重新连接：不可用原因作为纯文本显示，恢复成功进入运行页',options,async t=>{
 const b=await setup(t,{stage:'s03'});
 for(const reason of ['unreachable','degraded']){
  const result=await b.run(`${helpers}
   fixture.result={status:${JSON.stringify(reason==='degraded'?'degraded':'offline')},reason:${JSON.stringify(reason)},message:'服务诊断 <img src=x onerror="window.injected=true">'};
   $('[data-action="reconnect"]').click();
   if(!await until(()=>$('.connection-result')&&!$('[data-action="reconnect"]').disabled))throw Error('缺少检查结果');
   return {message:$('.connection-result').textContent,image:Boolean($('.connection-result img')),injected:Boolean(window.injected),composer:Boolean($('#composer'))};`);
  assert.match(result.message,/服务诊断 <img/);assert.equal(result.image,false);assert.equal(result.injected,false);assert.equal(result.composer,false);
 }
 const connected=await b.run(`${helpers}fixture.result={status:'ready'};$('[data-action="reconnect"]').click();if(!await until(()=>$('#composer')))throw Error('未进入运行页');return {notice:Boolean($('.connection-result')),reconnect:Boolean($('[data-action="reconnect"]'))};`);
 assert.deepEqual(connected,{notice:false,reconnect:false});
});
