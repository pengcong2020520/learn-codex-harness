import {stageCountLabel} from './stage-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorkbench,defaultTargets} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';
const ids=defaultTargets.filter(target=>target.id!=='project').map(target=>target.id);
const allIds=JSON.parse(fs.readFileSync(new URL('../../../stages/changes.json',import.meta.url),'utf8')).stages.map(stage=>stage.id);
const options={skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'};
async function setup(t){const app=createWorkbench({port:0,targets:[]});const url=await app.listen();t.after(()=>app.close());return {url,b:await browser(t)};}

test('浏览器：左栏包含全部已登记阶段，逐阶段检查资料/知识页签、能力说明与教学体验',options,async t=>{
 const {url,b}=await setup(t);
 for(const [num,id] of ids.entries()){
  await b.open(`${url}/?stage=${id}&view=run`);
  const result=await b.run(`${helpers}
   await until(()=>$('.stage.active')?.dataset.stage===${JSON.stringify(id)});
   // Wait for bootstrap/status refresh before clicking, so its render cannot race the assertions.
   await sleep(150);
   const out={ids:$$('.stages [data-stage]').map(el=>el.dataset.stage),numbers:$$('.stages .stage-no').map(el=>el.textContent),chapter:$('.page-head .eyebrow').textContent,tabs:$$('[data-tab]').map(el=>el.dataset.tab),storage:$('.aside').textContent};
   $('[data-tab="capabilities"]').click();await until(()=>$('#pane h2')?.textContent==='本阶段的能力与边界');
   out.capabilities=$('#pane').textContent;
   $('[data-tab="chat"]').click();await sleep(100);
   $('[data-action="preview"]').click();await until(()=>$('.notice.preview'));
   out.chat=$('#pane').textContent;out.tools=$$('#pane .tag').some(el=>el.textContent.includes('read_file'));out.workflow=Boolean($('.compose-modes'));
   return out;`);
  assert.deepEqual(result.ids,allIds);assert.deepEqual(result.numbers,allIds);
  assert.match(result.chapter,new RegExp(`CHAPTER ${id.slice(1)} /`));
  assert.equal(result.tabs.includes('files'),num>=6,id);assert.equal(result.tabs.includes('knowledge'),num>=9,id);
  assert.equal(result.storage.includes('PostgreSQL'),num>=8,id);
  if(num>=3&&num<8)assert.match(result.storage,/本地 JSON/);
  for(const [label,start] of [['Role + Skills',5],['Schema / Registry',6],['Memory',7],['outbox',8],['KB mount',9],['Workflow',10],['Bifrost',11]])assert.equal(result.capabilities.includes(label),num>=start,`${id}:${label}`);
  assert.equal(result.tools,num>=6,id);assert.equal(result.workflow,num>=10,id);
  if(num===0)assert.match(result.chat,/npm run hello/);
  if(num===3){assert.match(result.chat,/不排队/);assert.doesNotMatch(result.capabilities,/FIFO|SSE/);}
  if(num===5)assert.doesNotMatch(result.capabilities,/受控工具|当前工具白名单|Schema/);
 }
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('浏览器：旧 demoN 与未知链接映射，project 使用 s11 课程与能力',options,async t=>{
 const {url,b}=await setup(t);
 for(const [input,expected] of [['demo1','s01'],['demo2','s02'],['demo3','s07'],['demo4','s08'],['demo5','s09'],['unknown','s09'],['','s09'],['project','project']]){
  await b.open(`${url}/?stage=${input}`);
  const result=await b.run(`${helpers}await until(()=>$('.stage.active'));return {target:$('.stage.active').dataset.stage,links:$$('a[href^="/course/#"]').map(el=>el.getAttribute('href')),chapter:$('.page-head .eyebrow').textContent};`);
  assert.equal(result.target,expected,input);const stage=expected==='project'?'s11':expected;
  assert.deepEqual(result.links,[`/course/#${stage}`,`/course/#${stage}`]);assert.match(result.chapter,new RegExp(`CHAPTER ${stage.slice(1)} /`));
 }
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('A：1280×900 完整展示全部已登记阶段与当前项目，窄屏可横向滚动',options,async t=>{
 const {url,b}=await setup(t);await b.viewport(1280,900);await b.open(url+'/?stage=s03');
 const courseLinks=await b.run(`${helpers}await until(()=>$('.rail-course-links'));const rail=$('.rail-bottom').getBoundingClientRect();return $$('.rail-course-links a').map(el=>{const r=el.getBoundingClientRect();return {href:el.getAttribute('href'),visible:r.top>=rail.top&&r.bottom<=rail.bottom&&r.left>=rail.left&&r.right<=rail.right};});`);
 assert.deepEqual(courseLinks.map(link=>link.href),['/course/overview.html','/course/glossary.html']);
 assert.ok(courseLinks.every(link=>link.visible),'课程新入口不被侧栏底部裁切');
 // Read geometry from current nodes in one synchronous sample: refresh() may replace #app.
 for(const height of [900,780]){
  await b.viewport(1280,height);
  const desktop=await b.run(`${helpers}await until(()=>$$('[data-stage]').length===${allIds.length+1});const nav=$('.stages'),bottom=$('.rail-bottom').getBoundingClientRect();return {height:innerHeight,width:innerWidth,projectTop:bottom.top,projectBottom:bottom.bottom,scroll:nav.scrollHeight>nav.clientHeight,rows:$$('[data-stage]').map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.stage,left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('[data-stage]')===el};})};`);
  assert.equal(desktop.width,1280);assert.equal(desktop.height,height);assert.equal(desktop.scroll,false);
  assert.ok(desktop.projectTop>=0&&desktop.projectBottom<=height);
  assert.equal(desktop.rows.length,allIds.length+1); // every stage plus the project entry
  for(const row of desktop.rows){
   assert.ok(row.left>=0&&row.right<=1280&&row.top>=0&&row.bottom<=height&&row.visible,JSON.stringify({height,...row}));
   if(row.id!=='project')assert.ok(row.bottom<=desktop.projectTop,`${row.id} bottom ${row.bottom} > project top ${desktop.projectTop}`);
  }
 }
 await b.viewport(390,844);
 const mobile=await b.run(`${helpers}const nav=$('.stages');nav.scrollLeft=nav.scrollWidth;const last=$('[data-stage="${allIds.at(-1)}"]').getBoundingClientRect(),bounds=nav.getBoundingClientRect(),project=$('[data-stage="project"]').getBoundingClientRect();return {overflow:getComputedStyle(nav).overflowX,scrollable:nav.scrollWidth>nav.clientWidth,scrolled:nav.scrollLeft>0,lastVisible:last.left>=bounds.left-1&&last.right<=bounds.right+1,lastRight:last.right,navRight:bounds.right,scrollLeft:nav.scrollLeft,scrollWidth:nav.scrollWidth,clientWidth:nav.clientWidth,project:getComputedStyle($('.rail-bottom')).display,projectVisible:project.top>=bounds.bottom&&project.bottom<=innerHeight,documentFits:document.documentElement.scrollWidth<=innerWidth};`);
 assert.equal(mobile.overflow,'auto');// scrollLeft is an integer while button widths can be fractional: allow 1px of rounding.
 assert.ok(mobile.scrollable&&mobile.scrolled&&mobile.lastVisible,JSON.stringify(mobile));assert.notEqual(mobile.project,'none');assert.ok(mobile.projectVisible);assert.ok(mobile.documentFits);

});

// Browser-side fake transport: real modules, DOM and user interactions; no model or database.
const fakeTransport=`
 window.fixture={posts:[],reads:[],mode:'accepted',failState:false,failMemory:false,enabled:false,session:{id:'t',turns:[]}};
 const nativeFetch=window.fetch;
 window.fetch=async(input,init={})=>{
  const url=new URL(String(input),location.href),route=url.pathname,fixture=window.fixture;
  const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  if(route==='/api/status')return json({targets:Array.from({length:9},(_,i)=>({id:'s'+String(i+3).padStart(2,'0'),status:'ready'})).concat({id:'project',status:'ready'})});
  if(!route.startsWith('/api/agent/'))return nativeFetch(input,init);
  const endpoint='/'+route.split('/').slice(4).join('/');
  if(init.method==='POST'){
   const body=JSON.parse(init.body);fixture.posts.push({route,endpoint,body});
   if(endpoint==='/sessions')return json({id:'t',turns:[]});
   if(endpoint==='/turns'){
    fixture.failState=true;fixture.session={id:'t',turns:[{id:'turn-1',status:'completed',messages:[{text:body.text}],answers:{a:'完成'},tools:{}}]};
    if(fixture.mode==='unknown')throw Error('submission response lost');
    return json({threadId:'t',turnId:'turn-1',status:'completed'});
   }
   return json({});
  }
  fixture.reads.push(endpoint);
  if(endpoint==='/sessions')return json({sessions:[{id:'t',name:'Test session'}]});
  if(endpoint==='/state'){if(fixture.failState)throw Error('snapshot unavailable');return json({session:fixture.session,queue:{jobs:[]}});}
  if(endpoint==='/events')return new Response('');
  if(endpoint==='/workbench')return json({agent:{id:'fixture',version:'v1',workflows:[]}});
  if(endpoint==='/workflows')return json({workflows:[]});
  if(endpoint==='/tools')return json({status:'degraded',version:'tools-v1',pending:true,tools:[{name:'read_file'},{name:'list_files'}],error:'fixture tool warning'});
  if(endpoint==='/memory'){
   if(fixture.failMemory)throw Error('fixture memory unavailable');
   return json({configured:{enabled:fixture.enabled},effective:{enabled:fixture.enabled,use:fixture.enabled,generate:fixture.enabled,contribute:false},hasSummary:false,generationCapability:'blocked',generationWarning:'后台合并不能写出最终摘要',note:'已开启不等于已生成'});
  }
  if(endpoint==='/knowledge')return json({knowledge:[{kbId:'general',desiredMode:'wiki',effectiveMode:'wiki',actions:['read','update','index']}]});
  if(endpoint==='/knowledge/pages')return json({pages:[]});
  return json({});
 };`;

for(const mode of ['accepted','unknown'])test(`1：s03 ${mode} 故障后重试不重复 POST，未知结果显式核对`,options,async t=>{
 const {url,b}=await setup(t);await b.beforeLoad(fakeTransport);await b.open(url+'/?stage=s03&view=run');
 const first=await b.run(`${helpers}
  await until(()=>$('#composer'));window.fixture.mode=${JSON.stringify(mode)};
  $('#message').value='只执行一轮';$('#message').dispatchEvent(new Event('input',{bubbles:true}));$('#composer').requestSubmit();
  await until(()=>$('.submission-status')&&!$('#message').disabled);
  const out={posts:fixture.posts.filter(p=>p.endpoint==='/turns').length,notice:$('.submission-status').textContent,draft:$('#message').value,locked:$('[data-action="review-submission"]')?.disabled};
  $('#message').value='只执行一轮';$('#composer').requestSubmit();await sleep(150);out.retryPosts=fixture.posts.filter(p=>p.endpoint==='/turns').length;
  fixture.failState=false;$('[data-action="refresh-submission"]').click();await until(()=>!$('#message').disabled&&${mode==='accepted'?'!$(\'.submission-status\')':'$(\'[data-action="review-submission"]\')?.disabled===false'});
  out.afterRefresh=fixture.posts.filter(p=>p.endpoint==='/turns').length;out.answer=$('#timeline').textContent;out.noticeAfter=Boolean($('.submission-status'));
  if(${mode==='unknown'}){$('[data-action="review-submission"]').click();out.cleared=!$('.submission-status');out.afterReview=fixture.posts.filter(p=>p.endpoint==='/turns').length;}
  return out;`);
 assert.equal(first.posts,1);assert.equal(first.retryPosts,1);assert.equal(first.afterRefresh,1);assert.match(first.answer,/完成/);
 if(mode==='accepted'){assert.equal(first.draft,'');assert.match(first.notice,/turn-1/);assert.equal(first.noticeAfter,false);}
 else{assert.equal(first.draft,'只执行一轮');assert.match(first.notice,/结果未知/);assert.ok(first.locked&&first.noticeAfter&&first.cleared);assert.equal(first.afterReview,1);}
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('4：s06/s07 页面显示实际工具与记忆状态、错误和关闭/开启区别',options,async t=>{
 const {url,b}=await setup(t);await b.beforeLoad(fakeTransport);
 for(const id of ['s06','s07']){
  await b.open(url+'/?stage='+id);
  const actual=await b.run(`${helpers}await until(()=>$('.stage.active')&&fixture.reads.includes('/tools'));$('[data-tab="capabilities"]').click();await until(()=>$('.runtime-tools'));await sleep(100);return {tools:$('.runtime-tools').textContent,memory:$('.runtime-memory')?.textContent,reads:fixture.reads};`);
  assert.match(actual.tools,/degraded[\s\S]*tools-v1[\s\S]*read_file[\s\S]*fixture tool warning/);assert.equal(actual.reads.includes('/workbench'),false);
  if(id==='s06'){assert.equal(actual.memory,undefined);assert.equal(actual.reads.includes('/memory'),false);}
  else{
   assert.match(actual.memory,/记忆总开关：关闭[\s\S]*尚未生成[\s\S]*blocked[\s\S]*后台合并不能写出最终摘要/);
   const changed=await b.run(`${helpers}fixture.enabled=true;$('[data-tab="capabilities"]').click();await until(()=>$('.runtime-memory')?.textContent.includes('记忆总开关：开启'));return $('.runtime-memory').textContent;`);assert.match(changed,/记忆总开关：开启[\s\S]*尚未生成/);
   const failure=await b.run(`${helpers}fixture.failMemory=true;$('[data-tab="capabilities"]').click();await until(()=>$('.runtime-memory')?.textContent.includes('fixture memory unavailable'));return {memory:$('.runtime-memory').textContent,tools:$('.runtime-tools').textContent};`);
   assert.match(failure.memory,/尚未读取实际记忆状态/);assert.doesNotMatch(failure.memory,/记忆总开关：开启/);assert.match(failure.tools,/read_file/);
  }
 }
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('5/7：s03 浏览器文案准确区分内存、历史与索引，入口标题不再使用旧体系',options,async t=>{
 const {url,b}=await setup(t);await b.open(url+'/?stage=s03&view=run');
 const actual=await b.run(`${helpers}await until(()=>$('.stage.active'));await sleep(100);$('[data-action="preview"]').click();return {title:document.title,storage:$('.aside').textContent,strip:$('.upgrade-strip').textContent,tasks:$('#tasks').textContent};`);
 assert.match(actual.title,new RegExp(stageCountLabel));assert.match(actual.storage,/内存 Map 快照[\s\S]*Codex 原生历史[\s\S]*连接信息、运行元数据与会话位置索引/);
 assert.match(actual.strip,/内存快照 \+ Codex 原生历史，本地索引辅助恢复/);assert.doesNotMatch(actual.strip,/业务状态存放于/);assert.doesNotMatch(actual.tasks,/本地 JSON · 会话状态/);
});

test('6：知识页维护说明与点击后的请求授权一致',options,async t=>{
 const {url,b}=await setup(t);await b.beforeLoad(fakeTransport);
 for(const id of ['s09','s10','s11','project']){
  await b.open(url+'/?stage='+id);
  const actual=await b.run(`${helpers}await until(()=>fixture.reads.includes('/memory'));$('[data-tab="knowledge"]').click();await until(()=>$('[data-action="maintain"]'));const text=$('#pane').textContent;$('[data-action="maintain"]').click();await until(()=>fixture.posts.some(p=>p.endpoint==='/messages'));return {text,body:fixture.posts.find(p=>p.endpoint==='/messages').body};`);
  if(id==='s09'){assert.match(actual.text,/Wiki 维护是普通对话任务/);assert.deepEqual(actual.body.knowledge,{kbId:'general',operation:'update'});assert.equal(actual.body.workflow,undefined);}
  else{assert.match(actual.text,/knowledge-maintain Workflow[\s\S]*任务结束授权失效/);assert.equal(actual.body.workflow,'knowledge-maintain');assert.deepEqual(actual.body.params,{kbId:'general'});assert.equal(actual.body.knowledge,undefined);}
 }
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('第三轮 P2-2：s03 切阶段返回后刷新本轮状态，inProgress 自动变 completed 且 POST 一次',options,async t=>{
 const {url,b}=await setup(t);await b.beforeLoad(fakeTransport);await b.open(url+'/?stage=s03&view=run');
 const restored=await b.run(`${helpers}
  if(!await until(()=>$('#composer')))throw Error('composer missing');
  $('#message').value='只执行一轮';$('#composer').requestSubmit();
  if(!await until(()=>$('.submission-status')&&!$('#message').disabled))throw Error('submission notice missing');
  fixture.session.turns[0].status='inProgress';fixture.session.turns[0].answers={};
  $('[data-stage="s04"]').click();
  if(!await until(()=>$('.stage.active')?.dataset.stage==='s04'))throw Error('stage switch failed');
  $('[data-stage="s03"]').click();
  if(!await until(()=>$('.stage.active')?.dataset.stage==='s03'))throw Error('stage return failed');
  $('[data-tab="chat"]').click();
  if(!await until(()=>$('[data-action="refresh-submission"]')))throw Error('recovery button missing');
  fixture.failState=false;$('[data-action="refresh-submission"]').click();
  const restored=await until(()=>!$('.submission-status')&&!$('#message').disabled&&$('#threads').value==='t');
  return {restored,timeline:$('#timeline').textContent,posts:fixture.posts.filter(p=>p.endpoint==='/turns').length};`);
 assert.ok(restored.restored);assert.match(restored.timeline,/inProgress/);assert.doesNotMatch(restored.timeline,/自动完成结果/);assert.equal(restored.posts,1);
 const completed=await b.run(`${helpers}
  const reads=fixture.reads.filter(r=>r==='/state').length;
  fixture.session.turns[0].status='completed';fixture.session.turns[0].answers={a:'自动完成结果'};
  // No click or refresh after changing the upstream snapshot: only polling can update the DOM.
  const updated=await until(()=>$('#timeline').textContent.includes('自动完成结果'),5000);
  return {updated,timeline:$('#timeline').textContent,reads:fixture.reads.filter(r=>r==='/state').length-reads,posts:fixture.posts.filter(p=>p.endpoint==='/turns').length,thread:$('#threads').value};`);
 assert.ok(completed.updated);assert.match(completed.timeline,/completed[\s\S]*自动完成结果/);assert.ok(completed.reads>=1);assert.equal(completed.posts,1);assert.equal(completed.thread,'t');
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});


test('浏览器：s12 只展示独立部署说明与课程，不发 Agent 请求',options,async t=>{
 const {url,b}=await setup(t);await b.open(url+'/?stage=s12&view=run');
 const result=await b.run(`${helpers}await until(()=>$('.stage.active')?.dataset.stage==='s12');await sleep(150);return {pane:$('#pane').textContent,readme:$('#pane a').getAttribute('href'),tabs:$$('[data-tab]').map(el=>el.dataset.tab),connect:$$('[data-action="real"],[data-action="preview"],[data-action="reconnect"]').length,agentRequests:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/agent/')).length};`);
 assert.match(result.pane,/remote\.sh tunnel/);
 assert.match(result.readme,/stages\/s12-deploy\/README\.md$/);
 assert.deepEqual(result.tabs,['learn','chat']);assert.equal(result.connect,0);assert.equal(result.agentRequests,0);
});

test('浏览器：s13 只展示独立部署说明与课程，不发 Agent 请求',options,async t=>{
 const {url,b}=await setup(t);await b.open(url+'/?stage=s13&view=run');
 const result=await b.run(`${helpers}await until(()=>$('.stage.active')?.dataset.stage==='s13');await sleep(150);return {pane:$('#pane').textContent,readme:$('#pane a').getAttribute('href'),tabs:$$('[data-tab]').map(el=>el.dataset.tab),connect:$$('[data-action="real"],[data-action="preview"],[data-action="reconnect"]').length,agentRequests:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/agent/')).length};`);
 assert.match(result.pane,/remote\.sh tunnel/);
 assert.match(result.readme,/stages\/s13-auth\/README\.md$/);
 assert.deepEqual(result.tabs,['learn','chat']);assert.equal(result.connect,0);assert.equal(result.agentRequests,0);
});
test('浏览器：s14 只展示独立部署说明与课程，不发 Agent 请求',options,async t=>{
 const {url,b}=await setup(t);await b.open(url+'/?stage=s14&view=run');
 const result=await b.run(`${helpers}await until(()=>$('.stage.active')?.dataset.stage==='s14');await sleep(150);return {pane:$('#pane').textContent,readme:$('#pane a').getAttribute('href'),tabs:$$('[data-tab]').map(el=>el.dataset.tab),connect:$$('[data-action="real"],[data-action="preview"],[data-action="reconnect"]').length,agentRequests:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/agent/')).length};`);
 assert.match(result.pane,/remote\.sh tunnel/);
 assert.match(result.readme,/stages\/s14-isolation\/README\.md$/);
 assert.deepEqual(result.tabs,['learn','chat']);assert.equal(result.connect,0);assert.equal(result.agentRequests,0);
});

test('浏览器：s15 只展示独立部署说明与课程，不发 Agent 请求',options,async t=>{
 const {url,b}=await setup(t);await b.open(url+'/?stage=s15&view=run');
 const result=await b.run(`${helpers}await until(()=>$('.stage.active')?.dataset.stage==='s15');await sleep(150);return {pane:$('#pane').textContent,readme:$('#pane a').getAttribute('href'),tabs:$$('[data-tab]').map(el=>el.dataset.tab),connect:$$('[data-action="real"],[data-action="preview"],[data-action="reconnect"]').length,agentRequests:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/agent/')).length};`);
 assert.match(result.pane,/remote\.sh tunnel/);
 assert.match(result.readme,/stages\/s15-hub\/README\.md$/);
 assert.deepEqual(result.tabs,['learn','chat']);assert.equal(result.connect,0);assert.equal(result.agentRequests,0);
});

test('浏览器：s16 只展示独立部署说明与课程，不发 Agent 请求',options,async t=>{
 const {url,b}=await setup(t);await b.open(url+'/?stage=s16&view=run');
 const result=await b.run(`${helpers}await until(()=>$('.stage.active')?.dataset.stage==='s16');await sleep(150);return {pane:$('#pane').textContent,readme:$('#pane a').getAttribute('href'),tabs:$$('[data-tab]').map(el=>el.dataset.tab),connect:$$('[data-action="real"],[data-action="preview"],[data-action="reconnect"]').length,agentRequests:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/agent/')).length};`);
 assert.match(result.pane,/remote\.sh tunnel/);
 assert.match(result.readme,/stages\/s16-coordination\/README\.md$/);
 assert.deepEqual(result.tabs,['learn','chat']);assert.equal(result.connect,0);assert.equal(result.agentRequests,0);
});
