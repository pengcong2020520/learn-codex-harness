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
