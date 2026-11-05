// 章节长文（/course/handbook.html）：静态检查 + 无头 Chrome 实测交互。找不到 Chrome 时只跳过浏览器部分（CI 的 ubuntu 镜像自带 Chrome）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorkbench} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';

const course=new URL('../public/course/',import.meta.url);

async function workbench(t){const app=createWorkbench({port:0,targets:[]});const url=await app.listen();t.after(()=>app.close());return url;}

test('长文页面没有内联脚本和外部资源，CSP 只允许同源脚本',async t=>{
 const url=await workbench(t);const res=await fetch(url+'/course/handbook.html');assert.equal(res.status,200);
 const csp=res.headers.get('content-security-policy'),scripts=csp.match(/script-src ([^;]+)/)[1];
 assert.equal(scripts.trim(),"'self'");assert.doesNotMatch(csp,/googleapis|gstatic|https:/);
 const html=await res.text();
 assert.doesNotMatch(html,/\son[a-z]+=/i,'不能有内联事件');assert.doesNotMatch(html,/<script(?![^>]*\ssrc=)/,'不能有内联 <script>');assert.doesNotMatch(html,/https?:\/\/(?!127\.0\.0\.1)[^"'\s]*\.(css|js|woff2?)/,'不能加载外部样式、脚本或字体');
 assert.equal((html.match(/<section class="module" id="module-\d"/g)||[]).length,5);
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
  return {count:diagrams.length,loaded,links:diagrams.every(el=>{const a=$('a',el),img=$('img',el);return a.href===img.src&&a.target==='_blank'&&a.rel.includes('noopener')&&img.alt.includes('总架构');})};`);
 assert.deepEqual(arch,{count:5,loaded:true,links:true});

 const term=await b.run(`${helpers}
  const term=$('.term');term.focus();const tip=$('#term-tip');
  const out={shown:!tip.hidden,text:tip.textContent===term.dataset.definition,described:term.getAttribute('aria-describedby'),focusable:term.tabIndex===0};
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));out.closed=tip.hidden;return out;`);
 assert.deepEqual(term,{shown:true,text:true,described:'term-tip',focusable:true,closed:true});

 const nav=await b.run(`${helpers}
  $('.nav-dot[data-target="module-3"]').click();const reached=await until(()=>$('.nav-dot[data-target="module-3"]').classList.contains('is-active'));
  const top=$('#module-3').getBoundingClientRect().top;scrollTo(0,document.documentElement.scrollHeight);await until(()=>$('.progress-bar').getAttribute('aria-valuenow')==='100');
  return {reached,current:$('.nav-dot[aria-current="true"]')?.dataset.target,top,hash:location.hash,progress:$('.progress-bar').getAttribute('aria-valuenow'),last:$('.nav-dot.is-active').dataset.target};`);
 assert.ok(nav.reached);assert.equal(nav.hash,'#module-3');assert.ok(nav.top>=0&&nav.top<200,`章节标题应在顶栏下方：${nav.top}`);assert.equal(nav.progress,'100');assert.equal(nav.last,'module-5');
 assert.deepEqual(b.errors,[],'页面不应有脚本错误或 CSP 拦截');
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
