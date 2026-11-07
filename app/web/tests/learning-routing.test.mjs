import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const curriculum=JSON.parse(read('../public/course/curriculum.json'));
const main=read('../public/app/main.js');
const workbench=[...main.slice(main.indexOf('const stages={'),main.indexOf('};',main.indexOf('const stages={'))).matchAll(/^ (s\d\d):\{/gm)].map(match=>match[1]);
const published=curriculum.chapters.map(chapter=>chapter.id);
const missing=workbench.filter(id=>!published.includes(id));
const lessonOf=id=>curriculum.lessons.find(lesson=>lesson.stage.slice(0,3)===id);
const publishedStage=published.find(lessonOf);
const publishedLesson=lessonOf(publishedStage);
const learning=read('../public/app/learning.js').replace(/^export /gm,'');
const reader=read('../public/course/reader.js').replace(/^import .*;\n/,'').replace("window.addEventListener('hashchange',()=>void openLesson());void openLesson();",'');
function fixture(hash,search=''){
 const listeners=new Map(),root={innerHTML:'',isConnected:true,contains:()=>true,querySelector:()=>null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const location={hash,search};
 const context=vm.createContext({URLSearchParams,location,document:{querySelector:()=>root,title:''},history:{replaceState:(_a,_b,url)=>{location.url=url;}},fetch:async()=>({ok:true,json:async()=>curriculum})});
 vm.runInContext(learning+'\n'+reader,context);
 return {root,context,location,run:code=>vm.runInContext(code,context),click:dataset=>listeners.get('click')({target:{closest:()=>({dataset,disabled:false})}})};
}

test('2：真实课程实验渲染使用 s05 / s06，生成副本与源文件一致',async()=>{
 assert.equal(read('../public/app/learning.js'),read('../public/course/learning.js'));
 for(const id of ['s05','s06']){
  const f=fixture('#'+id);await f.run('openLesson()');
  await f.click({learnAction:'view',view:'experiment'});
  assert.match(f.root.innerHTML,new RegExp(`href="/app/index.html\\?stage=${id}&view=run"`));
 }
});

test('3：完整阅读器缺课保持阶段，已有 lesson 参数不会导致回落；随后仍可选已发布阶段',async()=>{
 assert.ok(missing.length&&publishedLesson);
 const lessonId=publishedLesson.id,lessonPattern=lessonId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 for(const id of missing){
  const f=fixture('#'+id,'?lesson='+encodeURIComponent(lessonId));await f.run('openLesson()');
  assert.equal(f.location.hash,'#'+id);assert.equal(f.location.url,undefined);
  assert.match(f.root.innerHTML,new RegExp(`data-stage="${id}"`));assert.match(f.root.innerHTML,/该阶段暂无机制课程/);
  assert.doesNotMatch(f.root.innerHTML,new RegExp(`data-learn-action="lesson"|${lessonPattern}`));
  assert.match(f.context.document.title,new RegExp(id.toUpperCase()));
  f.location.hash='#'+publishedStage;await f.run('openLesson()');assert.match(f.root.innerHTML,new RegExp(`data-id="${lessonPattern}" aria-current="page"`));
  f.location.hash='#'+id;await f.run('openLesson()');assert.doesNotMatch(f.root.innerHTML,/data-learn-action="lesson"/);
 }
});
