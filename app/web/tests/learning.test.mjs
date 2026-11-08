import {stageIds} from './stage-fixture.mjs';
import {stageCountLabel} from './stage-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';
import fs from 'node:fs';
const curriculum=JSON.parse(fs.readFileSync(new URL('../public/course/curriculum.json',import.meta.url),'utf8'));
const main=fs.readFileSync(new URL('../public/app/main.js',import.meta.url),'utf8');
const workbench=[...main.slice(main.indexOf('const stages={'),main.indexOf('};',main.indexOf('const stages={'))).matchAll(/^ (s\d\d):\{/gm)].map(match=>match[1]);
const published=curriculum.chapters.map(chapter=>chapter.id);
const missing=workbench.filter(id=>!published.includes(id));
const lessonOf=id=>curriculum.lessons.find(lesson=>lesson.stage.slice(0,3)===id);
const projectStage=main.match(/stages\[id==='project'\?'(s\d\d)':id\]/)[1];

const options={skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'};
async function setup(t){
 const app=createWorkbench({port:0,targets:[]});const url=await app.listen();
 t.after(()=>app.close());return {url,b:await browser(t)};
}

test('阅读器按阶段哈希定位，兼容五个旧 Demo 链接与课时链接',options,async t=>{
 const {url,b}=await setup(t);
 for(const [hash,id] of [['s01','s01-transport'],['s02','s02-fifo'],['s03','s03-resident'],['s04','s04-queue'],['s05','s05-agent-config'],['s06','s06-tool-registry'],['s08','s08-persistence'],['s09','s09-gate'],['module-1','s01-transport'],['module-2','s02-fifo'],['module-3','s05-agent-config'],['module-4','s08-persistence'],['module-5','s09-gate']]){
  await b.open(`${url}/course/#${hash}`);
  assert.equal(await b.run(`${helpers} return await until(()=>$('[data-learn-action="lesson"][aria-current="page"]')?.dataset.id===${JSON.stringify(id)});`),true,hash);
 }
 await b.open(url+'/course/?lesson=s06-mcp');
 assert.equal(await b.run(`${helpers} return await until(()=>$('[aria-current="page"][data-id="s06-mcp"]'));`),true);
 // 已有 ?lesson 时，后续 hashchange 仍应跳转到请求阶段。
 assert.equal(await b.run(`${helpers} location.hash='s08';return await until(()=>$('[aria-current="page"][data-id="s08-persistence"]'));`),true);
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('课堂支持阶段 ID、目录名、阶段数组与全部模式，实验目录和架构图跟随阶段',options,async t=>{
 assert.ok(missing.length);
 const {url,b}=await setup(t);await b.open(url+'/course/');
 const result=await b.run(`${helpers}
  await until(()=>$('.learn-title'));
  const {mountLearning}=await import('/course/learning.js'),root=$('#course-reader');
  const ids=()=>$$('[data-learn-action="lesson"]',root).map(el=>el.dataset.id),out={};
  await mountLearning(root,{stage:'s06'});out.short=ids();
  out.image=$('.learn-overview img',root).getAttribute('src');
  $('[data-view="experiment"]',root).click();out.command=$('.learn-command pre',root).textContent;
  out.live=$('.learn-live-link',root).getAttribute('href');
  await mountLearning(root,{stage:'s06-tools'});out.directory=ids();
  await mountLearning(root,{stage:['s05','s06-tools'],lessonId:'s06-mcp'});out.pair=ids();
  out.selected=$('[aria-current="page"]',root).dataset.id;out.groups=$$('.learn-group',root).map(el=>el.textContent);
  await mountLearning(root,{all:true});out.all=ids();out.allGroups=$$('.learn-group',root).map(el=>el.textContent);
  await mountLearning(root,{stage:${JSON.stringify(missing[0])}});out.empty=$('.learn-error',root).textContent;return out;`);
 assert.deepEqual(result.short,['s06-tool-registry','s06-mcp','s06-workspace']);
 assert.deepEqual(result.directory,result.short);
 assert.deepEqual(result.pair,['s05-agent-config','s05-skills',...result.short]);
 assert.equal(result.selected,'s06-mcp');assert.deepEqual(result.groups,['S05 · Agent 装配','S06 · 工具']);
 assert.equal(result.image,'/course/assets/s06-architecture.svg');
 assert.match(result.command,/^cd stages\/s06-tools\n/);assert.equal(result.live,'/app/index.html?stage=s06&view=run');
 assert.equal(result.all.length,curriculum.lessons.length);assert.equal(result.allGroups.length,curriculum.chapters.length);assert.equal(result.empty,'该阶段暂无机制课程');
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('工作台按真实阶段选课：s00–s17 与 project，课程缺失时显示空态',options,async t=>{
 const {url,b}=await setup(t);
 for(const target of [...stageIds,'project']){
  const hash=target==='project'?'s11':target;
  const stages=curriculum.lessons.some(l=>l.stage.startsWith(hash))?[hash]:[];
  await b.open(`${url}/app/index.html?stage=${target}`);
  const result=await b.run(`${helpers}
   await until(()=>$('#learning-root .learn-title')||$('#learning-root .learn-error'));
   return {stages:[...new Set($$('#learning-root [data-learn-action="lesson"]').map(el=>el.dataset.id.slice(0,3)))],links:$$('a[href^="/course/#"]').map(el=>el.getAttribute('href'))};`);
  assert.deepEqual(result.stages,stages,target);assert.deepEqual(result.links,[`/course/#${hash}`,`/course/#${hash}`],target);
 }
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('2：s05/s06 实验链接点击后打开同阶段真实工作台',options,async t=>{
 const {url,b}=await setup(t);
 for(const id of ['s05','s06']){
  await b.open(`${url}/course/#${id}`);
  await b.run(`${helpers}await until(()=>$('.learn-title'));$('[data-view="experiment"]').click();`);
  await b.clickNavigate('.learn-live-link');
  const actual=await b.run(`${helpers}await until(()=>$('.stage.active')?.dataset.stage===${JSON.stringify(id)});return {stage:$('.stage.active')?.dataset.stage,tab:$('.tab.active')?.dataset.tab,title:document.title};`);
  assert.equal(actual.stage,id);assert.equal(actual.tab,'chat');assert.match(actual.title,new RegExp(stageCountLabel));
 }
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('3：从工作台点击本章教学，缺课阶段与 project 保留阶段并显示空态',options,async t=>{
 const {url,b}=await setup(t);
 assert.ok(missing.length&&projectStage);
 for(const target of [...missing,'project']){
  const stage=target==='project'?projectStage:target;
  await b.open(`${url}/?stage=${target}`);
  await b.run(`${helpers}await until(()=>$('.top-links a'));`);
  await b.clickNavigate('.top-links a');
  if(published.includes(stage)){
   const lesson=lessonOf(stage);
   const actual=await b.run(`${helpers}await until(()=>$('[data-learn-action="lesson"][aria-current="page"]'));return {selected:$('[data-learn-action="lesson"][aria-current="page"]').dataset.id,search:location.search,text:$('#course-reader').textContent};`);
   assert.equal(actual.selected,lesson.id,target);assert.equal(actual.search,'?lesson='+lesson.id,target);assert.doesNotMatch(actual.text,/该阶段暂无机制课程/,target);
  }else{
   const actual=await b.run(`${helpers}await until(()=>$('#course-reader .learn-empty'));return {stage:$('.learn-empty')?.dataset.stage,hash:location.hash,text:$('#course-reader')?.textContent,selected:$('[data-learn-action="lesson"][aria-current="page"]')?.dataset.id};`);
   assert.equal(actual.stage,stage,target);assert.equal(actual.hash,'#'+stage,target);assert.match(actual.text,/该阶段暂无机制课程/,target);assert.equal(actual.selected,undefined,target);
  }
 }
 // hashchange with an existing ?lesson must also clear the old lesson.
 const lessonId=lessonOf(published.find(lessonOf)).id,gap=missing[0];
 await b.open(url+'/course/?lesson='+encodeURIComponent(lessonId));
 const actual=await b.run(`${helpers}await until(()=>$('.learn-title'));location.hash=${JSON.stringify(gap)};await until(()=>$('.learn-empty'));return {stage:$('.learn-empty')?.dataset.stage,selected:Boolean($('.learn-title'))};`);
 assert.deepEqual(actual,{stage:gap,selected:false});
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});
