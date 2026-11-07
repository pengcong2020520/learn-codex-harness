// 章节长文（/course/handbook.html）：静态检查 + 无头 Chrome 实测交互。找不到 Chrome 时只跳过浏览器部分（CI 的 ubuntu 镜像自带 Chrome）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorkbench} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';

const course=new URL('../public/course/',import.meta.url);
const repository=new URL('../../../',import.meta.url);
const stages=fs.readdirSync(new URL('modules/',course)).filter(file=>/^s\d{2}-[a-z0-9-]+\.html$/.test(file)).sort().map(file=>file.slice(0,3));
const chapterSources=[
 ['s03','s03-service.html','s03-service'],
 ['s04','s04-events.html','s04-events-messages'],
 ['s05','s05-agent.html','s05-agent-assembly'],
 ['s06','s06-tools.html','s06-tools'],
 ['s07','s07-memory.html','s07-memory'],
 ['s10','s10-skill-workflow.html','s10-skill-workflow']
];
const retainedAnchors={
 'm3-screen-1':'s05','m3-screen-2':'s05','m3-screen-3':'s05',
 'm3-screen-4':'s06','m3-screen-5':'s05','m3-screen-6':'s07','m3-quiz':'s06'
};
const decodeHtml=text=>text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#x27;':"'",'&#39;':"'"})[entity]);

test('长文静态：阶段目录、锚点、资源与新增章节的逐行源码一致',()=>{
 const html=fs.readFileSync(new URL('handbook.html',course),'utf8');
 assert.deepEqual([...html.matchAll(/<section class="module" id="module-(s\d{2})"/g)].map(m=>m[1]),stages);
 assert.deepEqual([...html.matchAll(/<span class="module-number">(s\d{2})<\/span>/g)].map(m=>m[1]),stages);
 assert.doesNotMatch(html,/module-\d|\{\{(?:dots|modules|coursePath|firstModule)\}\}/);
 const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length,'章节及交互组件 ID 不重复');
 for(const [,id] of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.includes(id),`锚点存在：${id}`);
 for(const [,id] of html.matchAll(/data-quiz="([^"]+)"/g))assert.ok(ids.includes(id),`测验目标存在：${id}`);
 const paths=[...html.matchAll(/<nav class="course-path"[^>]*>([\s\S]*?)<\/nav>/g)];
 assert.equal(paths.length,1,'只有一份自动生成的课程目录');
 assert.deepEqual([...paths[0][1].matchAll(/href="#module-(s\d{2})"/g)].map(m=>m[1]),stages);
 assert.deepEqual([...html.matchAll(/class="nav-dot" data-target="module-(s\d{2})"/g)].map(m=>m[1]),stages);
 assert.doesNotMatch(html,/\son[a-z]+\s*=/i);
 assert.doesNotMatch(html,/<script(?![^>]*\ssrc=)/i);
 const architectureAlts=[...html.matchAll(/<img[^>]+src="\/course\/assets\/s\d{2}-architecture\.svg"[^>]+alt="([^"]+)"/g)];
 assert.equal(architectureAlts.length,stages.length);
 for(const [,alt] of architectureAlts){
  assert.match(alt,/橙色为本阶段新增，白色为前面阶段已有，绿色为 Codex 原生(?:。|$)/);
  assert.doesNotMatch(alt,/虚线/,'替代文本与实际图例一致');
 }
 for(const tag of html.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*>/gi)){
  for(const [,url] of tag[0].matchAll(/(?:src|href|poster)="([^"]+)"/g)){
   assert.doesNotMatch(url,/^(?:https?:)?\/\//i,'不能加载外部资源');
   if(url==='data:,')continue;
   const resource=new URL(url.startsWith('/course/')?url.slice('/course/'.length):url,course);
   assert.ok(fs.existsSync(resource),`资源存在：${url}`);
  }
 }
 for(const [stage,file,sourceDirectory] of chapterSources){
  const chapter=fs.readFileSync(new URL(`modules/${file}`,course),'utf8');
  const screens=[...chapter.matchAll(/<section class="screen /g)];
  assert.ok(screens.length>=3&&screens.length<=6);
  assert.ok((chapter.match(/class="quiz-question-block"/g)||[]).length>=3);
  assert.match(chapter,/class="term" data-definition="[^"]+"/);
  assert.ok(chapter.indexOf(`/course/assets/${stage}-architecture.svg`)<chapter.indexOf(`id="${stage}-screen-2"`),'总架构图位于前段');
  assert.match(chapter,new RegExp(`href="/course/changes.html#${stage}"`));
  assert.doesNotMatch(chapter,/拆分|迁移|原来的|改名/,'正文不讲项目改造史');
  const snippets=[...chapter.matchAll(/<code data-source="([^"]+)" data-start="(\d+)" data-end="(\d+)">([\s\S]*?)<\/code>/g)];
  assert.ok(snippets.length>=2,'有可核对的真实源码');
  for(const [,file,start,end,code] of snippets){
   assert.ok(file.startsWith(`stages/${sourceDirectory}/`),'源码必须出自本章对应的阶段目录');
   const lines=fs.readFileSync(new URL(file,repository),'utf8').split('\n');
   assert.ok(Number(start)>=1&&Number(end)>=Number(start)&&Number(end)<=lines.length,'源码行号有效');
   assert.equal(decodeHtml(code),lines.slice(Number(start)-1,Number(end)).join('\n'),`${file}:${start}–${end} 逐行一致`);
  }
  for(const [,encoded] of chapter.matchAll(/data-steps='([^']+)'/g)){
   const steps=JSON.parse(decodeHtml(encoded));
   assert.ok(steps.length>1);
   for(const step of steps){
    assert.ok(ids.includes(step.highlight));
    for(const actor of [step.from,step.to])assert.ok(ids.includes(actor)||ids.includes(`flow-${actor}`));
   }
  }
 }
 for(const [id,stage] of Object.entries(retainedAnchors)){
  const file=chapterSources.find(([s])=>s===stage)[1];
  assert.ok(fs.readFileSync(new URL(`modules/${file}`,course),'utf8').includes(`id="${id}"`),`${id} 保留在 ${stage}`);
 }
 const script=fs.readFileSync(new URL('handbook.js',course),'utf8');
 assert.match(script,/'#module-3': 'module-s05'/,'旧章链接继续指向 Agent 装配');
});

async function workbench(t){const app=createWorkbench({port:0,targets:[]});const url=await app.listen();t.after(()=>app.close());return url;}

test('长文页面没有内联脚本和外部资源，CSP 只允许同源脚本',async t=>{
 const url=await workbench(t);const res=await fetch(url+'/course/handbook.html');assert.equal(res.status,200);
 const csp=res.headers.get('content-security-policy'),scripts=csp.match(/script-src ([^;]+)/)[1];
 assert.equal(scripts.trim(),"'self'");assert.doesNotMatch(csp,/googleapis|gstatic|https:/);
 const html=await res.text();
 assert.doesNotMatch(html,/\son[a-z]+=/i,'不能有内联事件');assert.doesNotMatch(html,/<script(?![^>]*\ssrc=)/,'不能有内联 <script>');assert.doesNotMatch(html,/https?:\/\/(?!127\.0\.0\.1)[^"'\s]*\.(css|js|woff2?)/,'不能加载外部样式、脚本或字体');
 assert.equal((html.match(/<section class="module" id="module-s\d{2}"/g)||[]).length,stages.length);
 for(const removed of ['styles.css','main.js','_base.html','_footer.html','build.sh','course.css','course.js'])assert.ok(!fs.existsSync(new URL(removed,course)),`${removed} 应已移除`);
});


test('长文交互：测验、对话推演、流程推演、架构图、术语释义、章节导航与阅读进度',{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await workbench(t),b=await browser(t);
 await b.open(url+'/course/handbook.html',{reduceMotion:true});

 const quiz=await b.run(`${helpers}
  const quiz=$('#m1-quiz'),[first,second]=$$('.quiz-question-block',quiz),check=$('.quiz-check-btn[data-quiz="m1-quiz"]'),reset=$('.quiz-reset-btn[data-quiz="m1-quiz"]');
  const right=$('.quiz-option[data-value="'+first.dataset.correct+'"]',first),wrong=$$('.quiz-option',second).find(o=>o.dataset.value!==second.dataset.correct);
  right.click();wrong.click();const pressed=right.getAttribute('aria-pressed');check.click();
  const out={pressed,firstKind:$('.quiz-feedback',first).className,firstText:$('.quiz-feedback',first).textContent,locked:$$('.quiz-option',first).every(o=>o.disabled),
   secondKind:$('.quiz-feedback',second).className,wrongMarked:wrong.classList.contains('is-wrong'),correctShown:$('.quiz-option[data-value="'+second.dataset.correct+'"]',second).classList.contains('is-correct')};
  reset.click();out.afterReset=$$('.quiz-option',quiz).every(o=>!o.disabled&&!/is-(selected|correct|wrong)/.test(o.className))&&$$('.quiz-feedback',quiz).every(f=>f.textContent==='');
  check.click();out.unanswered=$('.quiz-feedback',first).textContent;return out;`);
 assert.equal(quiz.pressed,'true');assert.equal(quiz.firstKind,'quiz-feedback success');assert.match(quiz.firstText,/^回答正确。.+/);assert.ok(quiz.locked);
 assert.equal(quiz.secondKind,'quiz-feedback error');assert.ok(quiz.wrongMarked&&quiz.correctShown,'答错时标出所选与正确选项');assert.ok(quiz.afterReset);assert.equal(quiz.unanswered,'请先选择一个答案。');

 const chat=await b.run(`${helpers}
  const box=$('#m1-chat'),messages=$$('.chat-message',box),progress=$('.chat-progress',box);
  const out={total:messages.length,hiddenAtStart:messages.every(m=>m.hidden),start:progress.textContent};
  $('.chat-next-btn',box).click();await until(()=>!messages[0].hidden);out.one=progress.textContent;out.secondHidden=messages[1].hidden;
  $('.chat-all-btn',box).click();out.allShown=await until(()=>messages.every(m=>!m.hidden));out.end=progress.textContent;out.nextDisabled=$('.chat-next-btn',box).disabled;
  $('.chat-reset-btn',box).click();out.reset=messages.every(m=>m.hidden)&&progress.textContent===out.start;return out;`);
 assert.ok(chat.total>1&&chat.hiddenAtStart);assert.equal(chat.start,`0 / ${chat.total} 条`);assert.equal(chat.one,`1 / ${chat.total} 条`);assert.ok(chat.secondHidden);
 assert.ok(chat.allShown);assert.equal(chat.end,`${chat.total} / ${chat.total} 条`);assert.ok(chat.nextDisabled);assert.ok(chat.reset);

 const flow=await b.run(`${helpers}
  const box=$('#m2-flow'),steps=JSON.parse(box.dataset.steps),label=$('.flow-step-label',box),packet=$('.flow-packet',box),next=$('.flow-next-btn',box),intro=label.textContent;
  next.click();const to=$('#flow-'+steps[0].to,box).getBoundingClientRect(),p=packet.getBoundingClientRect();
  const out={steps:steps.length,active:$$('.flow-actor.is-active',box).map(a=>a.id),label:label.textContent===steps[0].label,progress:$('.flow-progress',box).textContent,
   packetVisible:!packet.hidden,packetOnTarget:Math.abs(p.left+p.width/2-(to.left+to.width/2))<2&&Math.abs(p.top+p.height/2-(to.top+to.height/2))<2};
  for(let i=1;i<steps.length;i++)next.click();out.done=next.disabled&&$('.flow-progress',box).textContent===steps.length+' / '+steps.length;
  $('.flow-reset-btn',box).click();out.reset=!$('.flow-actor.is-active',box)&&label.textContent===intro&&packet.hidden&&!next.disabled;return out;`);
 assert.deepEqual(flow.active,['flow-m2-user']);assert.ok(flow.label);assert.equal(flow.progress,`1 / ${flow.steps}`);assert.ok(flow.packetVisible&&flow.packetOnTarget,'数据包停在目标参与方中心');assert.ok(flow.done);assert.ok(flow.reset);

 const arch=await b.run(`${helpers}
  const diagrams=$$('.architecture-figure');
  const loaded=await until(()=>diagrams.every(el=>{const img=$('img',el);return img.complete&&img.naturalWidth===1600&&img.naturalHeight===Number(img.getAttribute("height"));}));
  return {count:diagrams.length,loaded,links:diagrams.every(el=>{const a=$('a',el),img=$('img',el);return a.href===img.src&&a.target==='_blank'&&a.rel.includes('noopener')&&(img.alt.includes('总架构')||a.getAttribute('aria-label')?.includes('总架构'));})};`);
 assert.deepEqual(arch,{count:stages.length,loaded:true,links:true});

 const term=await b.run(`${helpers}
  const term=$('.term');term.focus();const tip=$('#term-tip');
  const out={shown:!tip.hidden,text:tip.textContent===term.dataset.definition,described:term.getAttribute('aria-describedby'),focusable:term.tabIndex===0};
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));out.closed=tip.hidden;return out;`);
 assert.deepEqual(term,{shown:true,text:true,described:'term-tip',focusable:true,closed:true});

 const additions=await b.run(`${helpers}
  return ['s03','s04','s10'].map(stage=>{
   const module=$('#module-'+stage),quiz=$('#'+stage+'-quiz');
   for(const question of $$('.quiz-question-block',quiz))$('.quiz-option[data-value="'+question.dataset.correct+'"]',question).click();
   $('.quiz-check-btn',module).click();
   const correct=$$('.quiz-feedback',quiz).every(el=>el.classList.contains('success'));
   $('.quiz-reset-btn',module).click();
   const reset=$$('.quiz-option',quiz).every(el=>!el.disabled&&!el.classList.contains('is-selected'));
   const flow=$('#'+stage+'-flow'),steps=JSON.parse(flow.dataset.steps);
   for(const step of steps)$('.flow-next-btn',flow).click();
   const done=$('.flow-next-btn',flow).disabled&&$('.flow-step-label',flow).textContent===steps.at(-1).label;
   $('.flow-reset-btn',flow).click();
   const flowReset=!$('.flow-next-btn',flow).disabled&&$('.flow-packet',flow).hidden;
   const term=$('.term',module);term.focus();const tooltip=!$('#term-tip').hidden&&$('#term-tip').textContent===term.dataset.definition;
   return {stage,correct,reset,done,flowReset,tooltip};
  });`);
 assert.deepEqual(additions,['s03','s04','s10'].map(stage=>({stage,correct:true,reset:true,done:true,flowReset:true,tooltip:true})));

 const assemblyToolsMemory=await b.run(`${helpers}
  return [['s05','s05-quiz'],['s06','m3-quiz'],['s07','s07-quiz']].map(([stage,id])=>{
   const module=$('#module-'+stage),quiz=$('#'+id,module),questions=$$('.quiz-question-block',quiz);
   for(const question of questions) $('.quiz-option[data-value="'+question.dataset.correct+'"]',question).click();
   $('.quiz-check-btn',module).click();
   const correct=$$('.quiz-feedback',quiz).every(el=>el.classList.contains('success'));
   $('.quiz-reset-btn',module).click();
   const reset=$$('.quiz-option',quiz).every(el=>!el.disabled&&!el.classList.contains('is-selected'))&&$$('.quiz-feedback',quiz).every(el=>el.textContent==='');
   const first=questions[0],wrong=$$('.quiz-option',first).find(el=>el.dataset.value!==first.dataset.correct);
   wrong.click();$('.quiz-check-btn',module).click();
   const explained=$('.quiz-feedback',first).classList.contains('error')&&$('.quiz-feedback',first).textContent.includes(first.dataset.explanationWrong);
   $('.quiz-reset-btn',module).click();
   const term=$('.term',module);term.focus();
   const tooltip=!$('#term-tip').hidden&&$('#term-tip').textContent===term.dataset.definition;
   return {stage,count:questions.length>=3,correct,reset,explained,tooltip};
  });`);
 assert.deepEqual(assemblyToolsMemory,['s05','s06','s07'].map(stage=>({stage,count:true,correct:true,reset:true,explained:true,tooltip:true})));

 const directory=await b.run(`${helpers}
  const targets=[];
  for(const link of $$('.course-path a')){
   link.click();const id=link.hash.slice(1);
   if(!await until(()=>$('.nav-dot[data-target="'+id+'"]').classList.contains('is-active')))throw Error('目录未到达 '+id);
   targets.push(location.hash);
  }
  return targets;`);
 assert.deepEqual(directory,stages.map(stage=>'#module-'+stage));

 const nav=await b.run(`${helpers}
  $('.nav-dot[data-target="module-s05"]').click();const reached=await until(()=>$('.nav-dot[data-target="module-s05"]').classList.contains('is-active'));
  const top=$('#module-s05').getBoundingClientRect().top;scrollTo(0,document.documentElement.scrollHeight);await until(()=>$('.progress-bar').getAttribute('aria-valuenow')==='100');
  return {reached,current:$('.nav-dot[aria-current="true"]')?.dataset.target,top,hash:location.hash,progress:$('.progress-bar').getAttribute('aria-valuenow'),last:$('.nav-dot.is-active').dataset.target};`);
 assert.ok(nav.reached);assert.equal(nav.hash,'#module-s05');assert.ok(nav.top>=0&&nav.top<200,`章节标题应在顶栏下方：${nav.top}`);assert.equal(nav.progress,'100');assert.equal(nav.last,'module-'+stages.at(-1));
 assert.deepEqual(b.errors,[],'页面不应有脚本错误或 CSP 拦截');
});

test('长文旧书签：首次打开与页内 hash 跳转兼容五章旧锚点，保留新锚点和内部锚点',{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await workbench(t),b=await browser(t);
 const legacyStages=['s01','s02','s05','s08','s09'];
 async function assertChapter(stage){
  const result=await b.run(`${helpers}
   const id=${JSON.stringify(`module-${stage}`)};
   const reached=await until(()=>location.hash==='#'+id&&$('.nav-dot[data-target="'+id+'"]').classList.contains('is-active')&&$('#'+id).getBoundingClientRect().top>=0&&$('#'+id).getBoundingClientRect().top<200);
   return {reached,hash:location.hash,top:$('#'+id).getBoundingClientRect().top};`);
  assert.ok(result.reached,`${stage} 标题应在顶栏下方且导航激活：${JSON.stringify(result)}`);
  assert.equal(result.hash,'#module-'+stage);
 }
 for(const [index,stage] of legacyStages.entries()){
  // 不同查询参数确保每次加载文档，覆盖直接打开旧书签的初始化路径。
  await b.open(`${url}/course/handbook.html?legacy=${index+1}#module-${index+1}`,{reduceMotion:true});
  await assertChapter(stage);
 }
 for(const [index,stage] of legacyStages.entries()){
  await b.run(`location.hash='#module-${index+1}';`);
  await assertChapter(stage);
 }
 const retained=await b.run(`${helpers}
  const ids=['module-s03','module-s04','module-s06','module-s07',...[1,2,4,5].map(n=>$('.screen[id^="m'+n+'-"]').id),...Object.keys(${JSON.stringify(retainedAnchors)})];
  const retained=${JSON.stringify(retainedAnchors)};
  for(const id of ids){
   location.hash='#'+id;
   if(!await until(()=>$('#'+id).getBoundingClientRect().top>=0&&$('#'+id).getBoundingClientRect().top<200))throw Error('锚点未到达 '+id);
   if(location.hash!=='#'+id)throw Error('锚点被错误改写 '+id);
   if(retained[id]&&$('#'+id).closest('.module').id!=='module-'+retained[id])throw Error('锚点所属章节错误 '+id);
  }
  return ids.length;`);
 assert.equal(retained,8+Object.keys(retainedAnchors).length);
 assert.deepEqual(b.errors,[],'旧链接兼容不应产生脚本错误或 CSP 拦截');
});

test('长文淡入：首屏直接显示，滚动到的内容会显示出来，不会一直隐藏',{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await workbench(t),b=await browser(t);
 await b.open(url+'/course/handbook.html');
 const reveal=await b.run(`${helpers}
  const firstScreen=$$('.animate-in').filter(el=>el.getBoundingClientRect().top<innerHeight);
  const pendingBefore=$$('.is-pending').length,target=$$('.is-pending').at(-1);
  target.scrollIntoView();const shown=await until(()=>!target.classList.contains('is-pending'));
  return {firstVisible:firstScreen.length>0&&firstScreen.every(el=>!el.classList.contains('is-pending')),pendingBefore,shown};`);
 assert.ok(reveal.firstVisible);assert.ok(reveal.pendingBefore>0);assert.ok(reveal.shown);
 assert.deepEqual(b.errors,[]);
});
