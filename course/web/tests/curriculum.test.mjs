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


test('s15 三课覆盖五个 catalog 实验，授权、交集与审批摘录逐字命中',()=>{
 const output=buildCurriculumData(),lessons=output.lessons.filter(l=>l.stage==='s15-hub');
 assert.deepEqual(lessons.map(l=>l.id),['s15-scope','s15-intersection','s15-skill-approval']);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons.filter(e=>e.stage==='s15-hub');
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'../../../stages/s15-hub/lessons/catalog.json'),'utf8'));
 const experiments=manifest.flatMap(e=>[e,...(e.relatedExperiments||[])]);
 assert.deepEqual(experiments.map(e=>e.catalogId).sort(),catalog.map(e=>e.id).sort());
 for(const exp of experiments){
  const original=catalog.find(e=>e.id===exp.catalogId);
  for(const key of Object.keys(original))if(key!=='id')assert.deepEqual(exp[key],original[key],`${exp.catalogId}.${key}`);
  assert.equal(exp.command,`npm run lesson -- ${original.id}`);
  assert.equal(exp.mode,'offline');
 }
 const excerpts=lessons.flatMap(l=>[l.source,...l.sources]);
 for(const name of ['can(user','effectiveTools','shareSkill','reviewSkill'])assert.ok(excerpts.some(e=>e.code.includes(name)),name);
 for(const excerpt of excerpts){
  const original=fs.readFileSync(path.join(source,'../../..',excerpt.file),'utf8');
  assert.ok(original.includes(excerpt.needle));
  assert.equal(excerpt.code,original.split('\n').slice(excerpt.start-1,excerpt.start-1+excerpt.code.split('\n').length).join('\n'));
 }
 const mechanisms=JSON.parse(fs.readFileSync(path.join(source,'mechanisms/s15.json'),'utf8'));
 assert.deepEqual(mechanisms.map(m=>m.id),['s15-skill-share','s15-knowledge-share']);
 const states=m=>m.steps.reduce((s,step)=>({...s,...step.state}),m.state0);
 assert.equal(states(mechanisms[0]).轮次,'下一轮可用');
 assert.equal(states(mechanisms[1]).读取,'404');
 for(const mechanism of mechanisms)for(const step of mechanism.steps)assert.ok(step.flow?.[2].trim(),'每条箭头有动作和机制名称');
});

test('s16 三课覆盖六个 catalog 实验，租约、任期事务及 SQL 触发器逐字命中',()=>{
 const output=buildCurriculumData(),lessons=output.lessons.filter(l=>l.stage==='s16-coordination');
 assert.deepEqual(lessons.map(l=>l.id),['s16-lease','s16-election','s16-fencing']);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons.filter(e=>e.stage==='s16-coordination');
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'../../../stages/s16-coordination/lessons/catalog.json'),'utf8'));
 const experiments=manifest.flatMap(e=>[e,...e.relatedExperiments]);
 assert.deepEqual(experiments.map(e=>e.catalogId).sort(),catalog.map(e=>e.id).sort());
 for(const exp of experiments){
  const original=catalog.find(e=>e.id===exp.catalogId);
  for(const key of Object.keys(original))if(key!=='id')assert.deepEqual(exp[key],original[key]);
  assert.equal(exp.command,`npm run lesson -- ${original.id}`);assert.equal(exp.mode,'offline');
 }
 const excerpts=lessons.flatMap(l=>[l.source,...l.sources]);
 for(const name of ['async join()',"lease.on('lost'",'async elected(',"'Create', '=='",'CT001','CREATE TRIGGER'])assert.ok(excerpts.some(e=>e.code.includes(name)),name);
 for(const excerpt of excerpts){
  const original=fs.readFileSync(path.join(source,'../../..',excerpt.file),'utf8');
  assert.ok(excerpt.code.includes(excerpt.needle));
  assert.equal(excerpt.code,original.split('\n').slice(excerpt.start-1,excerpt.start-1+excerpt.code.split('\n').length).join('\n'));
 }
 const mechanisms=JSON.parse(fs.readFileSync(path.join(source,'mechanisms/s16.json'),'utf8'));
 assert.deepEqual(mechanisms.map(m=>m.id),['s16-takeover','s16-stale-control']);
 const final=m=>m.steps.reduce((s,step)=>({...s,...step.state}),m.state0);
 assert.equal(final(mechanisms[0]).入口,'新节点 ready');
 assert.equal(final(mechanisms[0])['PG 任期'],'新值');
 assert.equal(final(mechanisms[1]).写入,'CT001');
 assert.equal(final(mechanisms[1]).租约,'新 lease');
 assert.equal(final(mechanisms[1]).入口,'503');
 for(const m of mechanisms)for(const step of m.steps)assert.match(step.flow[2],/\S+ [\w/]+/,'箭头为简短动作 + 专有名词');
});

test('s16 SQL 补充摘录仍强制唯一 needle',t=>{
 const f=fixture(t);f.edit('lessons/s16.json',rows=>{rows[2].sources[0].needle='missing-trigger';});
 assert.throws(f.build,/Source needle missing or ambiguous/);
});

test('s17 三课覆盖四个 catalog 实验，策略、准入、SQL 与迁移逐字命中',()=>{
 const output=buildCurriculumData(),lessons=output.lessons.filter(l=>l.stage==='s17-sharding');
 assert.deepEqual(lessons.map(l=>l.id),['s17-routing','s17-fencing','s17-move']);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons.filter(e=>e.stage==='s17-sharding');
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'../../../stages/s17-sharding/lessons/catalog.json'),'utf8'));
 const experiments=manifest.flatMap(e=>[e,...e.relatedExperiments]);
 assert.deepEqual(experiments.map(e=>e.catalogId).sort(),catalog.map(e=>e.id).sort());
 for(const exp of experiments){
  const original=catalog.find(e=>e.id===exp.catalogId);
  for(const key of Object.keys(original))if(key!=='id')assert.deepEqual(exp[key],original[key]);
  assert.equal(exp.command,`npm run lesson -- ${original.id}`);assert.equal(exp.mode,'offline');
 }
 const excerpts=lessons.flatMap(l=>[l.source,...l.sources]);
 for(const name of ['shardOf','async canDispatch(', 'async admit(', 'SH001', 'CREATE TRIGGER shard_owner_guard', 'FOR SHARE', 'moveUser', 'await drain(', 'await copy(', "new Set(['tmp'])"])assert.ok(excerpts.some(e=>e.code.includes(name)),name);
 for(const excerpt of excerpts){
  const original=fs.readFileSync(path.join(source,'../../..',excerpt.file),'utf8');
  assert.ok(excerpt.code.includes(excerpt.needle));
  assert.equal(excerpt.code,original.split('\n').slice(excerpt.start-1,excerpt.start-1+excerpt.code.split('\n').length).join('\n'));
 }
 const mechanisms=JSON.parse(fs.readFileSync(path.join(source,'mechanisms/s17.json'),'utf8'));
 assert.deepEqual(mechanisms.map(m=>m.id),['s17-route-retry','s17-user-move']);
 const final=m=>m.steps.reduce((s,step)=>({...s,...step.state}),m.state0);
 assert.equal(final(mechanisms[0]).响应,'200');
 assert.equal(final(mechanisms[0]).重试,'1');
 assert.equal(final(mechanisms[1]).归属,'目标分片');
 assert.equal(final(mechanisms[1]).数据,'新节点续聊');
 for(const m of mechanisms)for(const step of m.steps)assert.match(step.flow[2],/\S+ [\w/]+/,'箭头为简短动作 + 专有名词');
});


test('s17 迁移补充摘录必须唯一命中',t=>{
 const f=fixture(t);f.edit('lessons/s17.json',rows=>{rows[2].sources[0].needle='missing-export';});
 assert.throws(f.build,/Source needle missing or ambiguous/);
});

test('s18 四课覆盖完整 catalog，摘录与实验保持真实来源',()=>{
 const lessons=buildCurriculumData().lessons.filter(l=>l.stage==='s18-replication');
 assert.deepEqual(lessons.map(l=>l.id),['s18-boundary','s18-lag','s18-recovery','s18-fence']);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'experiment-manifest.json'),'utf8')).lessons.filter(e=>e.stage==='s18-replication');
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'../../../stages/s18-replication/lessons/catalog.json'),'utf8'));
 const experiments=manifest.flatMap(e=>[e,...e.relatedExperiments]);
 assert.deepEqual(experiments.map(e=>e.catalogId).sort(),catalog.map(e=>e.id).sort());
 for(const exp of experiments){
  const original=catalog.find(e=>e.id===exp.catalogId);
  for(const key of Object.keys(original))if(key!=='id')assert.deepEqual(exp[key],original[key]);
  assert.equal(exp.command,`npm run lesson -- ${original.id}`);
 }
 for(const excerpt of lessons.flatMap(l=>[l.source,...l.sources])){
  const original=fs.readFileSync(path.join(source,'../../..',excerpt.file),'utf8');
  assert.equal(excerpt.code,original.split('\n').slice(excerpt.start-1,excerpt.start-1+excerpt.code.split('\n').length).join('\n'));
 }
 const text=JSON.stringify(lessons);
 for(const boundary of ['异步历史窗口','5 秒','300 秒','217 ms','3 Mbit/s','11.6 秒','262144','生产必须同地域','replica_missing','unconfirmed','needs-review','旧主以副本回归','不自动切回'])assert.ok(text.includes(boundary),boundary);
 const mechanisms=JSON.parse(fs.readFileSync(path.join(source,'mechanisms/s18.json'),'utf8'));
 const final=m=>m.steps.reduce((state,step)=>({...state,...step.state}),m.state0);
 assert.equal(final(mechanisms[0]).位点,'8');
 assert.equal(final(mechanisms[1]).就绪,'200');
 assert.equal(final(mechanisms[2]).epoch,'5');
 assert.equal(final(mechanisms[3]).旧主,'副本');
 assert.equal(final(mechanisms[3]).ready,'true');
});

test('s18 补充源码改动导致锚点失效时构建拒绝',t=>{
 const f=fixture(t);f.edit('lessons/s18.json',rows=>{rows[3].sources[0].needle='missing-rejoin';});
 assert.throws(f.build,/Source needle missing or ambiguous/);
});
