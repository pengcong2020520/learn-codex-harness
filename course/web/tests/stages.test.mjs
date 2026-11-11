import {stageCountLabel} from './stage-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {applySessionEvent,isSessionEvent} from '../shared/session-events.mjs';
import {defaultTargets} from '../server.mjs';

// Execute the actual rendering/request functions without a listener or a model.
const source=fs.readFileSync(new URL('../public/app/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const ids=defaultTargets.map(target=>target.id);
const allIds=JSON.parse(fs.readFileSync(new URL('../../../stages/changes.json',import.meta.url),'utf8')).stages.map(stage=>stage.id);
function frontend(search=''){
 const elements=new Map(['#app','#pane','#timeline','#tasks','#toast'].map(id=>[id,{innerHTML:'',classList:{add(){},remove(){}}}]));
 const calls=[],courses=[],timers=new Map();let timerId=0;
 const context=vm.createContext({URLSearchParams,applySessionEvent,isSessionEvent,location:{search},history:{replaceState(){}},AbortController,TextDecoder,crypto:{randomUUID:()=> 'test-id'},
  document:{querySelector:selector=>elements.get(selector)||null,querySelectorAll:()=>[],addEventListener(){}},
  mountLearning:(_root,options)=>courses.push(options.stage),disposeLearning(){},renderSingleTurnLesson:()=>'<div>single-turn lesson</div>',
  setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:async(route,options)=>{calls.push({route,options});return {ok:true,json:async()=>({})};}
 });
 vm.runInContext(source.slice(0,source.lastIndexOf("render();try{await raw('/api/bootstrap')")),context);
 return {run:code=>vm.runInContext(code,context),elements,calls,courses,timers,context};
}

test('全部阶段 的能力边界、目录、课程、启动命令与真实阶段号',()=>{
 const f=frontend();
 const boundaries={server:3,queue:4,agentDefinition:5,tools:6,memory:7,postgres:8,knowledge:9,workflow:10,gateway:11,workbenchInfo:8};
 for(const [num,id] of ids.entries()){
  f.run(`state.target=${JSON.stringify(id)};state.preview=false;state.tab='chat';render();`);
  const stage=f.run('stageOf(state.target)'),flags=f.run('has()'),actualNum=Math.min(num,11);
  assert.equal(stage.num,actualNum);assert.equal('n' in stage,false);
  assert.equal(defaultTargets[num].root.replace(/\/$/,'').endsWith('/'+stage.dir),true);
  for(const field of ['name','title','desc','gain','storage','tools','before','after'])assert.ok(stage[field],`${id}.${field}`);
  for(const [key,start] of Object.entries(boundaries))assert.equal(flags[key],actualNum>=start,`${id}.${key}`);
  assert.equal(flags.localJson,actualNum>=3&&actualNum<8);
  const shell=f.elements.get('#app').innerHTML;
  assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
  assert.match(shell,new RegExp(`CHAPTER ${String(actualNum).padStart(2,'0')} /`));
  assert.equal(shell.includes('data-tab="files"'),actualNum>=6);
  assert.equal(shell.includes('data-tab="knowledge"'),actualNum>=9);
  assert.equal(shell.includes('工具执行方式'),actualNum>=6||actualNum===0);
  assert.equal(shell.includes('PostgreSQL'),actualNum>=8);
  if(actualNum>=3&&actualNum<8)assert.match(shell,/本地 JSON/);
  assert.deepEqual([...shell.matchAll(/href="\/course\/#(s\d{2})"/g)].map(m=>m[1]),[ids[actualNum],ids[actualNum]]);
  f.run("state.tab='learn';renderPane()");assert.equal(f.courses.at(-1),ids[actualNum]);
  const command=f.run('commands()');
  assert.equal(command.includes('data:migrate'),actualNum>=8);
  assert.equal(command.includes('knowledge:init'),actualNum>=9);
  assert.equal(command.includes('agent:init'),actualNum>=10);assert.equal(command.includes('gateway:up'),actualNum>=11);
  assert.equal(command.split('\n').at(-1),actualNum===0?'npm run hello':actualNum<3?'npm start':'npm run server');
 }
});

test('能力说明与教学样例只呈现该阶段具备的能力',()=>{
 const f=frontend();
 for(const [num,id] of ids.entries()){
  f.run(`state.target='${id}';state.preview=true;state.session=null`);
  const html=f.run('capabilities()');
  for(const [label,start] of [['Role + Skills',5],['Schema / Registry',6],['Memory',7],['outbox',8],['通用门禁',9],['Workflow',10],['Bifrost',11]])assert.equal(html.includes(label),num>=start,`${id}: ${label}`);
  if(num===3){assert.match(html,/轮询/);assert.doesNotMatch(html,/FIFO|SSE|受控工具/);}
  if(num===5)assert.doesNotMatch(html,/受控工具|当前工具白名单|Schema|记忆配置/);
  assert.equal(f.run('conversation()').includes('read_file'),num>=6);
  assert.equal(f.run('workflowList().length>0'),num>=10);
 }
 f.run("state.target='s00'");assert.match(f.run('simulation()'),/SDK 脚本/);assert.match(f.run('simulation()'),/npm run hello/);
 f.run("state.target='s01'");assert.match(f.run('simulation()'),/single-turn lesson/);
 f.run("state.target='s02'");assert.match(f.run('simulation()'),/同一个会话/);
});

test('旧 demo1–5、未知值、缺省值与 project 链接解析',()=>{
 for(const [input,expected] of [['demo1','s01'],['demo2','s02'],['demo3','s07'],['demo4','s08'],['demo5','s09'],['demo6','s09'],['unknown','s09'],['toString','s09'],['__proto__','s09'],['','s09'],['project','s09'],...ids.map(id=>[id,id])]){
  const f=frontend(`?stage=${input}`);assert.equal(f.run('state.target'),expected,input);
 }
 assert.equal(frontend().run('state.target'),'s09');
});

test('真实刷新：早期服务不请求 /workbench，资料与知识请求遵循能力边界',async()=>{
 for(const [num,id] of ids.entries()){
  const f=frontend();f.run(`state.target='${id}';state.tab='chat'`);
  f.context.fetch=async route=>{f.calls.push(route);return {ok:true,json:async()=>route==='/api/status'?{targets:[{id,status:'ready'}]}:route.endsWith('/sessions')?{sessions:[]}:route.endsWith('/workbench')?{agent:{workflows:[{id:'chat'},{id:'test-workflow'}]}}:route.includes('/workspace')?{entries:[]}:route.endsWith('/knowledge')?{knowledge:[]}:{} };};
  await f.run('refresh()');
  assert.equal(f.calls.some(r=>r.endsWith('/workbench')),num>=8,id);
  assert.equal(f.calls.some(r=>r.endsWith('/sessions')),num>=3,id);
  assert.equal(f.calls.some(r=>r.endsWith('/workflows')),false,id);
  if(num>=10)assert.deepEqual(JSON.parse(f.run('JSON.stringify(workflowList().map(w=>w.id))')),['test-workflow']);
  for(const [tab,route,start] of [['files','/workspace?',6],['knowledge','/knowledge',9]]){
   f.calls.length=0;f.run(`state.tab='${tab}'`);await f.run('refresh()');assert.equal(f.calls.some(r=>r.includes(route)),num>=start,`${id}:${tab}`);
  }
 }
});

test('s03 提交 /turns、轮询 /state，切换阶段时中止；s04 提交 /messages',async()=>{
 for(const id of ['s03','s04']){
  const f=frontend();f.run(`state.target='${id}';state.tab='chat';state.thread='test-thread';state.session={turns:[]}`);
  f.context.fetch=async(route,options)=>{f.calls.push({route,options});return {ok:true,json:async()=>route==='/api/status'?{targets:[]}:{session:{id:'test-thread',turns:[]}}};};
  await f.run("send('test message')");
  const submission=f.calls.find(c=>c.options.method==='POST');
  assert.equal(submission.route,`/api/agent/${id}/${id==='s03'?'turns':'messages'}`);
  assert.equal(Object.hasOwn(JSON.parse(submission.options.body),'clientMessageId'),id==='s04');
  if(id==='s03'){
   f.calls.length=0;await f.run('subscribe()');await new Promise(resolve=>setImmediate(resolve));
   assert.ok(f.calls.every(c=>c.route.includes('/state?')));assert.ok(f.timers.size);
   const requestSignal=f.calls[0].options.signal;await f.run("selectStage('s00')");
   assert.equal(requestSignal.aborted,true);assert.equal(f.timers.size,1,'only the toast timer remains');
  }
 }
});


test('s04 起订阅 SSE 并应用快照，s03 轮询返回的迟到快照不污染新阶段',async()=>{
 const f=frontend();f.run("state.target='s04';state.tab='chat';state.thread='thread-sse'");
 const snapshot={type:'snapshot',threadId:'thread-sse',data:{session:{id:'thread-sse',turns:[]},queue:{jobs:[]}}};
 let read=false;
 f.context.fetch=async(route,options)=>{f.calls.push({route,options});return {ok:true,body:{getReader:()=>({read:async()=>read?{done:true}:(read=true,{done:false,value:new TextEncoder().encode('data: '+JSON.stringify(snapshot)+'\n\n')})})}};};
 await f.run('subscribe()');assert.match(f.calls[0].route,/\/s04\/events\?/);assert.equal(f.run('state.session.id'),'thread-sse');
 const late=frontend();late.run("state.target='s03';state.tab='chat';state.thread='old-thread'");
 let deliver;late.context.fetch=()=>new Promise(resolve=>{deliver=resolve;});
 await late.run('subscribe()');late.run("state.stream.abort();state.epoch++;state.target='s05';state.thread=null;state.session=null");
 deliver({ok:true,json:async()=>({session:{id:'old-thread',turns:[]}})});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(late.run('state.session'),null);assert.equal(late.timers.size,0);
});

test('A：阶段行只保留编号与名称，项目入口独立保留',()=>{
 const f=frontend();f.run('render()');const html=f.elements.get('#app').innerHTML;
 assert.doesNotMatch(html,/STAGE S\d{2}/);assert.doesNotMatch(html,/data-stage="project"/);
 assert.equal([...html.matchAll(/data-stage="s\d{2}"/g)].length,allIds.length);
});

test('1：s03 接收成功后刷新失败，保留 turnId、清空草稿，重试只读状态',async()=>{
 const f=frontend();f.run("state.target='s03';state.tab='chat';state.thread='t';state.drafts.s03='hello'");
 let fail=true,posts=0;
 f.context.fetch=async(route,options)=>{
  f.calls.push({route,options});if(options.method==='POST'){posts++;return {ok:true,json:async()=>({turnId:'turn-accepted'})};}
  if(fail)throw Error('snapshot unavailable');
  return {ok:true,json:async()=>({session:{id:'t',turns:[{id:'turn-accepted',status:'completed'}]}})};
 };
 await f.run("send('hello')");
 assert.equal(posts,1);assert.equal(f.run('state.turnSubmission.turnId'),'turn-accepted');assert.equal(f.run('state.drafts.s03'),'');
 assert.match(f.run('submissionNotice()'),/turn-accepted.*仅需刷新状态/);
 await f.run("send('hello')");assert.equal(posts,1);
 fail=false;await f.run("send('hello')");
 assert.equal(posts,1);assert.equal(f.run('state.turnSubmission'),null);assert.equal(f.run('state.session.turns[0].id'),'turn-accepted');
});

test('1：s03 结果未知必须先核对；改文案、切阶段、教学演示不会绕过锁定',async()=>{
 const f=frontend();f.run("state.target='s03';state.tab='chat';state.thread='t';state.drafts.s03='hello'");
 let posts=0;
 f.context.fetch=async(route,options)=>{
  if(options.method==='POST'){posts++;throw Error('connection lost');}
  return {ok:true,json:async()=>route==='/api/status'?{targets:[]}:{session:{id:'t',turns:[]}}};
 };
 await f.run("send('hello')");assert.equal(f.run('state.turnSubmission.status'),'unknown');
 await f.run("action('review-submission')");assert.equal(f.run('state.turnSubmission.status'),'unknown');
 await f.run("selectStage('s04')");await f.run("selectStage('s03')");
 await f.run("action('preview')");await f.run("send('preview only')");await f.run("action('real')");
 await f.run("send('changed text')");assert.equal(posts,1);assert.equal(f.run('state.thread'),'t');assert.equal(f.run('state.turnSubmission.checked'),true);
 assert.match(f.run('submissionNotice()'),/提交结果未知/);
 await f.run("action('review-submission')");assert.equal(f.run('state.turnSubmission'),null);
 await f.run("send('hello')");assert.equal(posts,2);
});

test('1：s03 明确拒绝可修正后发送；s04 未知结果沿用 clientMessageId 重试',async()=>{
 for(const id of ['s03','s04']){
  const f=frontend();f.run(`state.target='${id}';state.thread='t';state.drafts['${id}']='hello'`);
  let posts=0;const bodies=[];
  f.context.fetch=async(route,options)=>{
   if(options.method==='POST'){posts++;bodies.push(JSON.parse(options.body));if(posts===1){if(id==='s04')throw Error('lost');return {ok:false,status:409,json:async()=>({error:{message:'busy'}})};}return {ok:true,json:async()=>({turnId:'ok'})};}
   return {ok:true,json:async()=>({session:{id:'t',turns:[]}})};
  };
  await f.run("send('hello')");assert.equal(f.run(`state.drafts['${id}']`),'hello');
  if(id==='s03')assert.equal(f.run('state.turnSubmission'),null);
  await f.run("send('hello')");assert.equal(posts,2);
  if(id==='s04')assert.equal(bodies[0].clientMessageId,bodies[1].clientMessageId);
 }
});

test('4：独立能力请求边界、实际关闭/受限状态、接口失败与离线清理',async()=>{
 for(const id of ids){
  const f=frontend();f.run(`state.target='${id}';state.tab='capabilities'`);
  let failure=false,offline=false;
  f.context.fetch=async(route)=>{
   f.calls.push(route);if(route.endsWith('/memory')&&failure)throw Error('memory unavailable');
   return {ok:true,json:async()=>route==='/api/status'?{targets:[{id,status:offline?'offline':'ready'}]}:route.endsWith('/tools')?{status:'degraded',tools:[{name:'read_file<&>'}],version:'v1',pending:true,error:'tool warning'}:route.endsWith('/memory')?{effective:{enabled:false,use:false,generate:false,contribute:false},hasSummary:false,generationCapability:'blocked',generationWarning:'后台合并不能写出最终摘要',note:'已开启不等于已生成'}:{}};
  };
  await f.run('refresh()');const n=Number(id.slice(1));
  assert.equal(f.calls.some(r=>r.endsWith('/tools')),n>=6,id);assert.equal(f.calls.some(r=>r.endsWith('/memory')),n>=7,id);
  if(n>=6)assert.match(f.run('capabilities()'),/read_file&lt;&amp;&gt;[\s\S]*tool warning/);
  if(n>=7){
   assert.match(f.run('capabilities()'),/记忆总开关：关闭[\s\S]*尚未生成[\s\S]*blocked[\s\S]*后台合并不能写出最终摘要/);
   failure=true;await f.run('refresh()');assert.equal(f.run('state.memory'),null);assert.match(f.run('capabilities()'),/尚未读取实际记忆状态：读取失败：memory unavailable/);assert.ok(f.run('state.tools'));
  }
  offline=true;await f.run('refresh()');assert.equal(f.run('state.tools'),null);assert.equal(f.run('state.memory'),null);
  f.run("state.preview=true");assert.doesNotMatch(f.run('capabilities()'),/实际工具状态|实际记忆状态/);
 }
});

test('5：s03 会话快照、历史、索引与工作目录各有职责；s04 才展示持久任务记录',()=>{
 const f=frontend();f.run("state.target='s03';render()");
 const html=f.elements.get('#app').innerHTML;
 assert.match(html,/内存 Map 快照/);assert.match(html,/连接信息、运行元数据与会话位置索引/);assert.match(html,/项目 workspace/);
 assert.doesNotMatch(html,/业务状态存放于|本地 JSON · 会话状态|持久任务记录/);
 assert.match(f.run('taskList()'),/内存快照 \+ Codex 原生历史，本地索引辅助恢复/);
 f.run("state.target='s04';render()");assert.match(f.elements.get('#app').innerHTML,/本地 JSON · 持久任务记录/);
});

test('6：Wiki 文案与实际提交体按 s09 / s10–s11 的授权边界变化',async()=>{
 for(const id of ['s09','s10','s11']){
  const f=frontend();f.run(`state.target='${id}';state.preview=true`);
  const html=f.run('knowledge()');assert.equal(html.includes('Wiki 维护是普通对话任务'),id==='s09');assert.equal(html.includes('knowledge-maintain Workflow'),id!=='s09');
  f.run('state.preview=false');
  const posts=[];f.context.fetch=async(route,options)=>{
   if(options.method==='POST')posts.push({route,body:JSON.parse(options.body)});
   return {ok:true,json:async()=>route.endsWith('/sessions')?options.method==='POST'?{id:'t'}:{sessions:[{id:'t'}]}:{session:{id:'t',turns:[]}}};
  };
  await f.run("send('维护 Wiki',{kbId:'general',operation:'update'})");
  const body=posts.find(p=>p.route.endsWith('/messages')).body;
  if(id==='s09'){assert.deepEqual(body.knowledge,{kbId:'general',operation:'update'});assert.equal(body.workflow,undefined);}
  else{assert.equal(body.workflow,'knowledge-maintain');assert.deepEqual(body.params,{kbId:'general'});assert.equal(body.knowledge,undefined);}
 }
});

test('7：当前入口与工作台文档统一全部已登记阶段、实际课程覆盖与网关体验边界',()=>{
 const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
 assert.match(read('../public/app/index.html'),new RegExp(`<title>Agent Atelier · ${stageCountLabel}</title>`));
 const app=read('../../README.md'),web=read('../README.md'),root=read('../../../README.md');
 for(const doc of [app,web,root]){assert.match(doc,new RegExp(stageCountLabel));const curriculum=JSON.parse(read('../public/course/curriculum.json'));assert.ok(doc.includes(`s01–${curriculum.chapters.at(-1).id} 共 ${curriculum.lessons.length} 节`));assert.doesNotMatch(doc,/五次进化|(?<!十)五个阶段|s03 可配置 Agent|s09 \/ app/);}
 for(const id of allIds)assert.match(web,new RegExp(`\\| ${id}`));
 assert.match(web,/尚无 \/models、\/usage/);assert.match(web,/缺课空态|显示空态/);
});

test('1：迟到的提交前快照不会解除已接收或结果未知的提交保护',()=>{
 const f=frontend();f.run("state.target='s03';state.thread='t';state.turnSubmission={target:'s03',thread:'t',status:'accepted',turnId:'new-turn'}");
 f.run("receiveSnapshot({session:{id:'t',turns:[{id:'old-turn'}]}})");assert.equal(f.run('state.turnSubmission.turnId'),'new-turn');
 f.run("state.turnSubmission={target:'s03',thread:'t',status:'unknown',checked:false};receiveSnapshot({session:{id:'t',turns:[]}})");assert.equal(f.run('state.turnSubmission.checked'),false);
 f.run("receiveSnapshot({session:{id:'t',turns:[]}},{review:true})");assert.equal(f.run('state.turnSubmission.checked'),true);
});

test('4：一个能力已返回、另一个延迟时切换阶段，不写入旧配置',async()=>{
 const f=frontend();f.run("state.target='s07'");let deliver;
 f.context.fetch=async route=>route.endsWith('/tools')?{ok:true,json:async()=>({tools:[{name:'old_tool'}]})}:new Promise(resolve=>{deliver=resolve;});
 const reading=f.run('refreshCapabilities()');await new Promise(resolve=>setImmediate(resolve));
 f.run("state.epoch++;state.target='s03';state.tools=null;state.memory=null");
 deliver({ok:true,json:async()=>({effective:{enabled:true}})});
 await assert.rejects(reading,error=>error.cancelled);assert.equal(f.run('state.tools'),null);assert.equal(f.run('state.memory'),null);
});

test('第二轮：可选快照缺失与网络失败分类展示并清除旧值',async()=>{
 for(const mode of ['unavailable','http-error','network-error']){
  const f=frontend();f.run("state.target='s11';state.tools={tools:[{name:'stale'}]};state.memory={hasSummary:true}");
  f.context.fetch=async(route,options)=>{
   assert.equal(options.headers['x-workbench-optional'],'1');
   if(mode==='network-error')throw Error('connection lost');
   return {ok:mode!=='http-error',status:404,json:async()=>({available:false,error:{status:404,message:'当前目标未提供此接口'}})};
  };
  await f.run('refreshCapabilities()');
  assert.equal(f.run('state.tools'),null);assert.equal(f.run('state.memory'),null);
  const html=f.run('runtimeCapabilities()');assert.equal((html.match(mode==='network-error'?/读取失败：/g:/未提供：/g)||[]).length,2);assert.doesNotMatch(html,/stale|最终摘要：已存在/);
 }
});

for(const status of [404,401,403,503])test(`第三轮 P2-1：${status} 按接口缺失/读取失败分类并转义保留原因和错误码`,async()=>{
 for(const envelope of [true,false]){
 const f=frontend();f.run("state.target='s07';state.memory={hasSummary:true}");
 f.context.fetch=async route=>({ok:route.endsWith('/tools')||envelope,status,json:async()=>route.endsWith('/tools')?{tools:[{name:'read_file'}]}:{available:false,error:{status,code:'MEMORY_<UNVERIFIED>',message:'尚未核验 Codex 记忆配置。<img src=x onerror=alert(1)>'}}});
 await f.run('refreshCapabilities()');
 assert.equal(f.run('state.memory'),null);assert.ok(f.run('state.tools'));
 const html=f.run('runtimeCapabilities()');
 assert.match(html,new RegExp(status===404?'未提供：':'读取失败：'));
 assert.match(html,/尚未核验 Codex 记忆配置。&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.match(html,/MEMORY_&lt;UNVERIFIED&gt;/);assert.match(html,new RegExp(`HTTP ${status}`));
 assert.doesNotMatch(html,/<img|最终摘要：已存在/);
 }
});

test('第三轮 P2-2：s03 切阶段返回恢复待核对 Thread 后继续轮询至 completed，POST 仅一次',async()=>{
 const f=frontend();f.run("state.target='s03';state.tab='chat';state.thread='t';state.drafts.s03='hello'");
 let fail=true,posts=0,status='inProgress';const reads=[];
 f.context.fetch=async(route,options)=>{
  if(options.method==='POST'){posts++;return {ok:true,json:async()=>({turnId:'accepted-turn'})};}
  if(route.includes('/state?')){reads.push(route);if(fail)throw Error('snapshot unavailable');}
  return {ok:true,json:async()=>route==='/api/status'?{targets:[{id:'s03',status:'ready'}]}:route.endsWith('/sessions')?{sessions:[{id:'t'}]}:{session:{id:'t',turns:[{id:'accepted-turn',status,messages:[{text:'hello'}],answers:status==='completed'?{a:'自动完成结果'}:{},tools:{}}]}}};
 };
 await f.run("send('hello')");assert.equal(posts,1);assert.equal(f.run('state.turnSubmission.status'),'accepted');
 await f.run("selectStage('s04')");await f.run("selectStage('s03')");f.run("state.tab='chat'");
 assert.equal(f.run('state.thread'),null);assert.equal(f.run('state.stream'),null);assert.equal(f.timers.size,0);
 fail=false;await f.run("action('refresh-submission')");await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.run('state.thread'),'t');assert.equal(f.run('state.turnSubmission'),null);assert.equal(f.run('state.session.turns[0].status'),'inProgress');
 assert.ok(f.run('state.stream&&!state.stream.signal.aborted'),'恢复旧 Thread 的活动轮询');assert.equal(f.timers.size,1,'注册下一次轮询');
 const readCount=reads.length;status='completed';const [timer,poll]=[...f.timers][0];f.timers.delete(timer);await poll();
 assert.equal(reads.length,readCount+1);assert.ok(reads.every(route=>route==='/api/agent/s03/state?threadId=t'));
 assert.equal(f.run('state.session.turns[0].status'),'completed');assert.match(f.elements.get('#timeline').innerHTML,/自动完成结果/);assert.equal(posts,1);
 const stream=f.run('state.stream');await f.run("selectStage('s00')");assert.equal(stream.signal.aborted,true);assert.equal(f.timers.size,0);
});

test('重新连接：检查锁、结果时间、降级转义及恢复成功',async()=>{
 const f=frontend('?stage=s03&view=run');let release,requests=0;
 f.context.fetch=async()=>{requests++;return new Promise(resolve=>{release=result=>resolve({ok:true,json:async()=>({targets:[{id:'s03',...result}]})});});};
 const pending=f.run("action('reconnect')");await f.run("action('reconnect')");
 assert.equal(requests,1);assert.match(f.elements.get('#pane').innerHTML,/data-action="reconnect" disabled[^>]*>正在检查…/);
 release({status:'offline',reason:'not-started'});await pending;
 let html=f.elements.get('#pane').innerHTML;
 assert.match(html,/没有检测到 s03 的 Agent 服务/);assert.match(html,/stages\/s03-service 运行 npm run server/);
 assert.match(html,/<time datetime="[^"]+">检查时间：/);assert.equal(f.run('state.checking'),null);
 const degraded=f.run("action('reconnect')");release({status:'degraded',reason:'degraded',message:'服务原因 <img src=x onerror=alert(1)>'});await degraded;
 html=f.elements.get('#pane').innerHTML;assert.match(html,/服务原因 &lt;img/);assert.doesNotMatch(html,/<img/);assert.equal(f.run('live()'),false);
 f.context.fetch=async route=>({ok:true,json:async()=>route==='/api/status'?{targets:[{id:'s03',status:'ready'}]}:{sessions:[]}});
 await f.run("action('reconnect')");assert.match(f.elements.get('#pane').innerHTML,/id="composer"/);assert.doesNotMatch(f.elements.get('#pane').innerHTML,/connection-result/);
});

test('工作台会话过期：加载和重连都显示刷新入口，兼容旧服务错误',async()=>{
 for(const initial of [true,false]){
  const f=frontend(`?stage=s09${initial?'':'&view=run'}`);let reloaded=false;
  f.context.location.reload=()=>{reloaded=true;};
  f.context.fetch=async()=>({ok:false,status:401,json:async()=>({error:{message:'工作台会话已过期，请刷新页面。',...(initial?{code:'WORKBENCH_SESSION_EXPIRED'}:{})}})});
  if(initial)await f.run("(async()=>{render();try{await raw('/api/bootstrap');await refresh();}catch(e){state.error=e.message;render();}})()");
  else await f.run("action('reconnect')");
  const html=f.elements.get('#pane').innerHTML;
  assert.match(html,/本地工作台已重启，请刷新页面/);assert.match(html,/data-action="reload"/);assert.doesNotMatch(html,/data-action="reconnect"/);
  await f.run("action('reload')");assert.equal(reloaded,true);
 }
});

for(const legacy of [false,true])test(`工作台会话过期：s03 轮询立即显示刷新入口并停止（旧服务 ${legacy}）`,async()=>{
 const f=frontend('?stage=s03&view=run');let expired=false;
 f.run("state.statuses=[{id:'s03',status:'ready'}];state.thread='t';state.session={id:'t',turns:[]};render()");
 assert.match(f.elements.get('#pane').innerHTML,/id="composer"/);
 f.context.fetch=async(route,options)=>{
  f.calls.push({route,options});
  return {ok:!expired,status:expired?401:200,json:async()=>expired?{error:{message:'工作台会话已过期，请刷新页面。',...(legacy?{}:{code:'WORKBENCH_SESSION_EXPIRED'})}}:{session:{id:'t',turns:[]}}};
 };
 await f.run('subscribe()');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.timers.size,1);expired=true;
 const [timer,poll]=[...f.timers][0];f.timers.delete(timer);await poll();
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.route==='/api/agent/s03/state?threadId=t'));
 assert.equal(f.calls[1].options.signal.aborted,true);assert.equal(f.timers.size,0);
 const html=f.elements.get('#pane').innerHTML;
 assert.match(html,/本地工作台已重启，请刷新页面/);assert.match(html,/data-action="reload"/);
 assert.doesNotMatch(html,/id="composer"|data-action="reconnect"/);
});

test('重新连接：阶段切换后迟到的检查不覆盖新阶段',async()=>{
 const f=frontend('?stage=s03&view=run');let release;
 f.context.fetch=async()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({targets:[{id:'s03',status:'offline',reason:'not-started'}]})});});
 const pending=f.run("action('reconnect')");
 f.context.fetch=async()=>({ok:true,json:async()=>({targets:[{id:'s04',status:'offline',reason:'unreachable'}]})});
 await f.run("selectStage('s04')");release();await pending;
 assert.equal(f.run('state.target'),'s04');assert.equal(f.run('state.connectionResult'),null);assert.equal(f.run('state.checking'),null);
 assert.equal(f.run('state.statuses[0].id'),'s04');
});

// s12 有教材和独立部署说明，不能因为继承阶段能力而请求本地代理。
test('s12 卡片、课程和运行说明完整，刷新不请求任何实时服务', async()=>{
 const f=frontend('?stage=s12&view=run');
 f.run('render()');
 assert.equal(f.run('state.target'),'s12');
 const shell=f.elements.get('#app').innerHTML,pane=f.elements.get('#pane').innerHTML;
 assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
 assert.match(shell,new RegExp(stageCountLabel));
 assert.doesNotMatch(shell,/data-action="(?:real|preview|reconnect)"|data-tab="(?:files|knowledge)"/);
 assert.match(pane,/s12 是一套独立部署，用 remote.sh tunnel 经 SSH 隧道连接本机 http:\/\/127\.0\.0\.1:4326/);
 assert.match(pane,/href="[^" ]*stages\/s12-deploy\/README\.md"/);
 f.run("state.statuses=[{id:'s12',status:'ready'}]");
 assert.equal(f.run('live()'),false);
 await f.run('refresh()');
 await assert.rejects(f.run("api('/sessions')"),/SSH 隧道/);
 assert.deepEqual(f.calls,[]);
 f.run("state.tab='learn';renderPane()");
 assert.equal(f.courses.at(-1),'s12');
 assert.ok(!defaultTargets.some(t=>t.id==='s12'));
});

test('s13 属于上云与多用户，登录说明与课程可用，刷新和订阅不连接实时目标', async()=>{
 const f=frontend('?stage=s13&view=run');
 f.run('render()');
 assert.equal(f.run('state.target'),'s13');
 assert.equal(f.run("stageGroups.find(([label])=>label==='上云与多用户')[1].includes('s13')"),true);
 const shell=f.elements.get('#app').innerHTML,pane=f.elements.get('#pane').innerHTML;
 assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
 assert.match(shell,new RegExp(stageCountLabel));
 assert.doesNotMatch(shell,/data-action="(?:real|preview|reconnect)"|data-tab="(?:files|knowledge)"/);
 assert.match(pane,/s13 需要登录：remote.sh tunnel 后 npm run login/);
 assert.match(pane,/stages\/s13-auth\/README\.md/);
 assert.match(pane,/AGENT_SERVER_URL=http:\/\/127\.0\.0\.1:4327/);
 f.run("state.statuses=[{id:'s13',status:'ready'}]");
 assert.equal(f.run('live()'),false);
 await f.run('refresh()');
 await f.run('subscribe()');
 await assert.rejects(f.run("api('/sessions')"),/SSH 隧道/);
 assert.deepEqual(f.calls,[]);
 f.run("state.tab='learn';renderPane()");
 assert.equal(f.courses.at(-1),'s13');
 assert.ok(!defaultTargets.some(t=>['s12','s13','s14','s15','s16','s17','s18'].includes(t.id)));
});
test('s14 属于上云与多用户，登录说明与课程可用，刷新和订阅不连接实时目标', async()=>{
 const f=frontend('?stage=s14&view=run');
 f.run('render()');
 assert.equal(f.run('state.target'),'s14');
 assert.equal(f.run("stageGroups.find(([label])=>label==='上云与多用户')[1].includes('s14')"),true);
 const shell=f.elements.get('#app').innerHTML,pane=f.elements.get('#pane').innerHTML;
 assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
 assert.match(shell,new RegExp(stageCountLabel));
 assert.doesNotMatch(shell,/data-action="(?:real|preview|reconnect)"|data-tab="(?:files|knowledge)"/);
 assert.match(pane,/s14 是一套独立部署，用 remote.sh tunnel 经 SSH 隧道连接本机/);
 assert.match(pane,/stages\/s14-isolation\/README\.md/);
 assert.match(pane,/AGENT_SERVER_URL=http:\/\/127\.0\.0\.1:4328/);
 f.run("state.statuses=[{id:'s14',status:'ready'}]");
 assert.equal(f.run('live()'),false);
 await f.run('refresh()');
 await f.run('subscribe()');
 await assert.rejects(f.run("api('/sessions')"),/SSH 隧道/);
 assert.deepEqual(f.calls,[]);
 f.run("state.tab='learn';renderPane()");
 assert.equal(f.courses.at(-1),'s14');
 assert.ok(!defaultTargets.some(t=>['s12','s13','s14','s15','s16','s17','s18'].includes(t.id)));
});

test('s15 属于上云与多用户，登录说明与课程可用，刷新和订阅不连接实时目标', async()=>{
 const f=frontend('?stage=s15&view=run');
 f.run('render()');
 assert.equal(f.run('state.target'),'s15');
 assert.equal(f.run("stageGroups.find(([label])=>label==='上云与多用户')[1].includes('s15')"),true);
 const shell=f.elements.get('#app').innerHTML,pane=f.elements.get('#pane').innerHTML;
 assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
 assert.match(shell,new RegExp(stageCountLabel));
 assert.doesNotMatch(shell,/data-action="(?:real|preview|reconnect)"|data-tab="(?:files|knowledge)"/);
 assert.match(pane,/s15 是一套独立部署，用 remote.sh tunnel 经 SSH 隧道连接本机/);
 assert.match(pane,/stages\/s15-hub\/README\.md/);
 assert.match(pane,/AGENT_SERVER_URL=http:\/\/127\.0\.0\.1:4329/);
 f.run("state.statuses=[{id:'s15',status:'ready'}]");
 assert.equal(f.run('live()'),false);
 await f.run('refresh()');
 await f.run('subscribe()');
 await assert.rejects(f.run("api('/sessions')"),/SSH 隧道/);
 assert.deepEqual(f.calls,[]);
 f.run("state.tab='learn';renderPane()");
 assert.equal(f.courses.at(-1),'s15');
 assert.ok(!defaultTargets.some(t=>['s12','s13','s14','s15','s16','s17','s18'].includes(t.id)));
});

test('s16 属于多台机器，登录说明与课程可用，刷新和订阅不连接实时目标', async()=>{
 const f=frontend('?stage=s16&view=run');
 f.run('render()');
 assert.equal(f.run('state.target'),'s16');
 assert.equal(f.run("stageGroups.find(([label])=>label==='多台机器')[1].includes('s16')"),true);
 const shell=f.elements.get('#app').innerHTML,pane=f.elements.get('#pane').innerHTML;
 assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
 assert.match(shell,new RegExp(stageCountLabel));
 assert.doesNotMatch(shell,/data-action="(?:real|preview|reconnect)"|data-tab="(?:files|knowledge)"/);
 assert.match(pane,/s16 是一套独立部署，用 remote.sh tunnel 经 SSH 隧道连接本机/);
 assert.match(pane,/stages\/s16-coordination\/README\.md/);
 assert.match(pane,/AGENT_SERVER_URL=http:\/\/127\.0\.0\.1:4334/);
 f.run("state.statuses=[{id:'s16',status:'ready'}]");
 assert.equal(f.run('live()'),false);
 await f.run('refresh()');
 await f.run('subscribe()');
 await assert.rejects(f.run("api('/sessions')"),/SSH 隧道/);
 assert.deepEqual(f.calls,[]);
 f.run("state.tab='learn';renderPane()");
 assert.equal(f.courses.at(-1),'s16');
 assert.ok(!defaultTargets.some(t=>['s12','s13','s14','s15','s16','s17','s18'].includes(t.id)));
});

test('s17 属于多台机器，登录说明与课程可用，刷新和订阅不连接实时目标', async()=>{
 const f=frontend('?stage=s17&view=run');
 f.run('render()');
 assert.equal(f.run('state.target'),'s17');
 assert.equal(f.run("stageGroups.find(([label])=>label==='多台机器')[1].includes('s17')"),true);
 const shell=f.elements.get('#app').innerHTML,pane=f.elements.get('#pane').innerHTML;
 assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
 assert.match(shell,new RegExp(stageCountLabel));
 assert.doesNotMatch(shell,/data-action="(?:real|preview|reconnect)"|data-tab="(?:files|knowledge)"/);
 assert.match(pane,/s17 是一套独立部署，用 remote.sh tunnel 经 SSH 隧道连接本机/);
 assert.match(pane,/stages\/s17-sharding\/README\.md/);
 assert.match(pane,/AGENT_SERVER_URL=http:\/\/127\.0\.0\.1:4335/);
 f.run("state.statuses=[{id:'s17',status:'ready'}]");
 assert.equal(f.run('live()'),false);
 await f.run('refresh()');
 await f.run('subscribe()');
 await assert.rejects(f.run("api('/sessions')"),/SSH 隧道/);
 assert.deepEqual(f.calls,[]);
 f.run("state.tab='learn';renderPane()");
 assert.equal(f.courses.at(-1),'s17');
 assert.ok(!defaultTargets.some(t=>['s12','s13','s14','s15','s16','s17','s18'].includes(t.id)));
});

test('s18 属于多台机器，登录说明与课程可用，刷新和订阅不连接实时目标', async()=>{
 const f=frontend('?stage=s18&view=run');
 f.run('render()');
 assert.equal(f.run('state.target'),'s18');
 assert.equal(f.run("stageGroups.find(([label])=>label==='多台机器')[1].includes('s18')"),true);
 const shell=f.elements.get('#app').innerHTML,pane=f.elements.get('#pane').innerHTML;
 assert.deepEqual([...shell.matchAll(/data-stage="(s\d{2})"/g)].map(m=>m[1]),allIds);
 assert.match(shell,new RegExp(stageCountLabel));
 assert.doesNotMatch(shell,/data-action="(?:real|preview|reconnect)"|data-tab="(?:files|knowledge)"/);
 assert.match(pane,/s18 是一套独立部署，用 remote.sh tunnel 经 SSH 隧道连接本机/);
 assert.match(pane,/stages\/s18-replication\/README\.md/);
 assert.match(pane,/AGENT_SERVER_URL=http:\/\/127\.0\.0\.1:4336/);
 f.run("state.statuses=[{id:'s18',status:'ready'}]");
 assert.equal(f.run('live()'),false);
 await f.run('refresh()');
 await f.run('subscribe()');
 await assert.rejects(f.run("api('/sessions')"),/SSH 隧道/);
 assert.deepEqual(f.calls,[]);
 f.run("state.tab='learn';renderPane()");
 assert.equal(f.courses.at(-1),'s18');
 assert.ok(!defaultTargets.some(t=>['s12','s13','s14','s15','s16','s17','s18'].includes(t.id)));
});
