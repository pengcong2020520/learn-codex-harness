import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';

const options={skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'};
async function setup(t){
 const app=createWorkbench({port:0,targets:[]});const url=await app.listen();
 t.after(()=>app.close());return {url,b:await browser(t)};
}

test('阅读器按阶段哈希定位，兼容五个旧 Demo 链接与课时链接',options,async t=>{
 const {url,b}=await setup(t);
 for(const [hash,id] of [['s01','s01-transport'],['s02','s02-fifo'],['s05','s05-agent-config'],['s06','s06-tool-registry'],['s08','s08-persistence'],['s09','s09-gate'],['module-1','s01-transport'],['module-2','s02-fifo'],['module-3','s05-agent-config'],['module-4','s08-persistence'],['module-5','s09-gate']]){
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
  await mountLearning(root,{stage:'s11'});out.empty=$('.learn-error',root).textContent;return out;`);
 assert.deepEqual(result.short,['s06-tool-registry','s06-mcp','s06-workspace']);
 assert.deepEqual(result.directory,result.short);
 assert.deepEqual(result.pair,['s05-agent-config','s05-skills',...result.short]);
 assert.equal(result.selected,'s06-mcp');assert.deepEqual(result.groups,['S05 · Agent 装配','S06 · 工具']);
 assert.equal(result.image,'/course/assets/s06-architecture.svg');
 assert.match(result.command,/^cd stages\/s06-tools\n/);assert.equal(result.live,'/app/index.html?stage=s03&view=run');
 assert.equal(result.all.length,17);assert.equal(result.allGroups.length,6);assert.equal(result.empty,'该阶段暂无机制课程');
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('工作台按目标目录选课：s03 显示 s05/s06，其余目标及项目对应正确阶段',options,async t=>{
 const {url,b}=await setup(t);
 for(const [target,stages,hash] of [['s01',['s01'],'s01'],['s02',['s02'],'s02'],['s03',['s05','s06'],'s05'],['s08',['s08'],'s08'],['s09',['s09'],'s09'],['project',['s09'],'s09']]){
  await b.open(`${url}/app/index.html?stage=${target}`);
  const result=await b.run(`${helpers}
   await until(()=>$('#learning-root .learn-title'));
   return {stages:[...new Set($$('#learning-root [data-learn-action="lesson"]').map(el=>el.dataset.id.slice(0,3)))],links:$$('a[href^="/course/#"]').map(el=>el.getAttribute('href'))};`);
  assert.deepEqual(result.stages,stages,target);assert.deepEqual(result.links,[`/course/#${hash}`,`/course/#${hash}`],target);
 }
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});
