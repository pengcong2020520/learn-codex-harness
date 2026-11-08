import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildCurriculumData} from '../build-curriculum.mjs';

const source=fileURLToPath(new URL('../curriculum/',import.meta.url));
const stagesWithLessons=()=>fs.readdirSync(path.join(source,'lessons')).filter(f=>/^s\d\d\.json$/.test(f)&&JSON.parse(fs.readFileSync(path.join(source,'lessons',f),'utf8')).length).map(f=>f.slice(0,3)).sort();
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'course-validation-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.cpSync(path.join(source,'lessons'),path.join(dir,'lessons'),{recursive:true});
 fs.copyFileSync(path.join(source,'experiment-manifest.json'),path.join(dir,'experiment-manifest.json'));
 return {dir,build:()=>buildCurriculumData({curriculumDir:dir}),edit(file,change){
  const target=path.join(dir,file),value=JSON.parse(fs.readFileSync(target,'utf8'));
  change(value);fs.writeFileSync(target,JSON.stringify(value));
 }};
}

test('课程按源码阶段排序，章节目录与课时、实验一一对应',()=>{
 const output=buildCurriculumData();
 assert.equal('demos' in output,false);
 assert.deepEqual(output.chapters.map(c=>c.id),stagesWithLessons());
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons;
 const lessons=fs.readdirSync(path.join(source,'lessons')).sort().flatMap(f=>JSON.parse(fs.readFileSync(path.join(source,'lessons',f),'utf8')));
 assert.deepEqual(output.lessons.map(l=>l.id),lessons.map(l=>l.id));
 assert.deepEqual(output.lessons.map(l=>[l.id,l.stage]),manifest.map(l=>[l.id,l.stage]));
 for(const lesson of output.lessons){
  assert.equal('demo' in lesson,false);
  assert.ok(lesson.source.file.startsWith(output.chapters.find(c=>c.id===lesson.stage.slice(0,3)).dir+'/'));
 }
 assert.deepEqual(output,JSON.parse(fs.readFileSync(new URL('../public/course/curriculum.json',import.meta.url),'utf8')));
});

test('阶段与课时文件名不符时报错',t=>{
 const f=fixture(t);f.edit('lessons/s01.json',rows=>{rows[0].stage='s02-multi-turn';});
 assert.throws(f.build,/Lesson stage does not match filename/);
});
test('课时文件必须使用 sNN.json 命名',t=>{
 const f=fixture(t);fs.renameSync(path.join(f.dir,'lessons/s01.json'),path.join(f.dir,'lessons/s1.json'));
 assert.throws(f.build,/Invalid lesson filename/);
});
test('阶段必须是实际存在的目录',t=>{
 const f=fixture(t);f.edit('lessons/s01.json',rows=>{rows[0].stage='s01-missing';});
 assert.throws(f.build,/Invalid lesson stage/);
});
test('源码不在所属阶段目录时报错',t=>{
 const f=fixture(t);f.edit('lessons/s01.json',rows=>{rows[0].source.file='stages/s02-multi-turn/05-app-server.mjs';});
 assert.throws(f.build,/Invalid source path/);
});
test('源码路径不能跳出阶段目录',t=>{
 const f=fixture(t);f.edit('lessons/s01.json',rows=>{rows[0].source.file='stages/s01-single-turn/../s02-multi-turn/05-app-server.mjs';});
 assert.throws(f.build,/Invalid source path/);
});
test('实验清单缺课时时报错',t=>{
 const f=fixture(t);f.edit('experiment-manifest.json',m=>{m.lessons.shift();});
 assert.throws(f.build,/Missing experiment s01-transport/);
});
test('实验与课时数量相等但 ID 集合不同时报错',t=>{
 const f=fixture(t);f.edit('experiment-manifest.json',m=>{m.lessons[0].id='unknown';});
 assert.throws(f.build,/Missing experiment/);
});
test('实验清单多余课时时报错',t=>{
 const f=fixture(t);f.edit('experiment-manifest.json',m=>{m.lessons.push({...m.lessons[0],id:'extra'});});
 assert.throws(f.build,/equal counts and matching IDs/);
});
test('课时 ID 必须唯一',t=>{
 const f=fixture(t);f.edit('lessons/s01.json',rows=>{rows.push(rows[0]);});
 assert.throws(f.build,/Duplicate lesson/);
});
test('实验 ID 必须唯一',t=>{
 const f=fixture(t);f.edit('experiment-manifest.json',m=>{m.lessons.push(m.lessons[0]);});
 assert.throws(f.build,/Duplicate experiment/);
});
test('实验与课时必须属于同一阶段',t=>{
 const f=fixture(t);f.edit('experiment-manifest.json',m=>{m.lessons[0].stage='s02-multi-turn';});
 assert.throws(f.build,/Experiment stage mismatch/);
});
test('课时数量不写死，空阶段不输出章节',t=>{
 const f=fixture(t);f.edit('lessons/s01.json',rows=>{rows.length=0;});
 f.edit('experiment-manifest.json',m=>{m.lessons=m.lessons.filter(l=>l.stage!=='s01-single-turn');});
 const output=f.build();assert.ok(output.lessons.length>0);
 assert.equal(output.lessons.some(l=>l.stage==='s01-single-turn'),false);
 assert.deepEqual(output.chapters.map(c=>c.id),stagesWithLessons().filter(id=>id!=='s01'));
});

test('没有任何课时时报错',t=>{
 const f=fixture(t);
 for(const file of fs.readdirSync(path.join(f.dir,'lessons')))fs.writeFileSync(path.join(f.dir,'lessons',file),'[]');
 f.edit('experiment-manifest.json',value=>{value.lessons=[];});
 assert.throws(f.build,/Curriculum has no lessons/);
});

test('s12 三课、四组离线实验与真实 catalog 一致，所有补充摘录逐字命中',()=>{
 const output=buildCurriculumData(),lessons=output.lessons.filter(l=>l.stage==='s12-deploy');
 assert.equal(output.lessons.length,39);
 assert.deepEqual(lessons.map(l=>l.id),['s12-health','s12-protection','s12-backup']);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons.filter(e=>e.stage==='s12-deploy');
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'../../../stages/s12-deploy/lessons/catalog.json'),'utf8'));
 const experiments=manifest.flatMap(e=>[e,...(e.relatedExperiments||[])]);
 assert.deepEqual(experiments.map(e=>e.id).sort(),catalog.map(e=>e.id).sort());
 for(const exp of experiments){
  const original=catalog.find(e=>e.id===exp.id);
  for(const key of Object.keys(original))assert.deepEqual(exp[key],original[key],`${exp.id}.${key}`);
  assert.equal(exp.mode,'offline');
 }
 for(const lesson of lessons)for(const excerpt of [lesson.source,...lesson.sources]){
  assert.ok(excerpt.code.includes(excerpt.needle));
  assert.match(excerpt.hash,/^[a-f0-9]{64}$/);
 }
 assert.ok(lessons.some(l=>l.source.file.endsWith('compose.yaml')));
 assert.ok(lessons.some(l=>l.source.file.endsWith('deploy/backup.sh')));
});

test('s12 补充源码仍检查归属与唯一 needle',t=>{
 const f=fixture(t);
 f.edit('lessons/s12.json',rows=>{rows[0].sources[0].needle='missing-readiness-anchor';});
 assert.throws(f.build,/Source needle missing or ambiguous/);
});

test('s13 三课覆盖四个 catalog 实验，密码、令牌与 SSE 摘录逐字命中',()=>{
 const output=buildCurriculumData(),lessons=output.lessons.filter(l=>l.stage==='s13-auth');
 assert.equal(output.lessons.length,39);
 assert.deepEqual(lessons.map(l=>l.id),['s13-hash','s13-logout','s13-events']);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons.filter(e=>e.stage==='s13-auth');
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'../../../stages/s13-auth/lessons/catalog.json'),'utf8'));
 const experiments=manifest.flatMap(e=>[e,...(e.relatedExperiments||[])]);
 assert.deepEqual(experiments.map(e=>e.catalogId).sort(),catalog.map(e=>e.id).sort());
 for(const exp of experiments){
  const original=catalog.find(e=>e.id===exp.catalogId);
  for(const key of Object.keys(original))if(key!=='id')assert.deepEqual(exp[key],original[key],`${exp.catalogId}.${key}`);
  assert.equal(exp.command,`npm run lesson -- ${original.id}`);
  assert.equal(exp.mode,'offline');
 }
 for(const lesson of lessons)for(const excerpt of [lesson.source,...lesson.sources]){
  assert.ok(excerpt.code.includes(excerpt.needle));
  assert.match(excerpt.hash,/^[a-f0-9]{64}$/);
 }
 assert.match(lessons[0].source.code,/verifyPassword/);
 assert.match(lessons[1].source.code,/authenticate/);
 assert.match(lessons[2].source.code,/event.ownerId === identity.userId/);
});

test('s14 三课与 catalog 离线实验一一对应，池、spawn 环境与用户文件摘录准确',()=>{
 const output=buildCurriculumData(),lessons=output.lessons.filter(l=>l.stage==='s14-isolation');
 assert.equal(output.lessons.length,39);
 assert.deepEqual(lessons.map(l=>l.id),['s14-routing','s14-pool','s14-crash']);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons.filter(e=>e.stage==='s14-isolation');
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'../../../stages/s14-isolation/lessons/catalog.json'),'utf8'));
 assert.deepEqual(manifest.map(e=>e.catalogId),catalog.map(e=>e.id));
 for(const exp of manifest){
  const original=catalog.find(e=>e.id===exp.catalogId);
  for(const key of Object.keys(original))if(key!=='id')assert.deepEqual(exp[key],original[key],`${exp.catalogId}.${key}`);
  assert.equal(exp.command,`npm run lesson -- ${exp.catalogId}`);
 }
 const excerpts=lessons.flatMap(l=>[l.source,...l.sources]);
 for(const name of ['withOwner','userSpawn','userEnvironment','readAsUser'])assert.ok(excerpts.some(e=>e.code.includes(name)),name);
 for(const excerpt of excerpts){
  const original=fs.readFileSync(path.join(source,'../../..',excerpt.file),'utf8');
  assert.ok(original.includes(excerpt.needle));
  assert.equal(excerpt.code,original.split('\n').slice(excerpt.start-1,excerpt.start-1+excerpt.code.split('\n').length).join('\n'));
 }
});
