import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateGlossary,linkGlossaryTerms,escapeHtml,termId,sourceUrl} from '../course-data.mjs';
import {renderGlossary,renderOverview,introductionQuestions} from '../build-course-pages.mjs';
import {stages as architecture,stageModules} from '../../../stages/build-architecture.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const course=new URL('../public/course/',import.meta.url);
const glossary=JSON.parse(fs.readFileSync(new URL('../curriculum/glossary.json',import.meta.url),'utf8'));
const {stages}=JSON.parse(fs.readFileSync(path.join(repository,'stages/changes.json'),'utf8'));
const introduction=fs.readFileSync(path.join(repository,'stages/introduction.md'),'utf8');
const validate=rows=>validateGlossary(rows,{repository,stages});
const read=name=>fs.readFileSync(new URL(name,course),'utf8');

test('术语表：真实数据通过校验，锚点不随顺序、解释或阶段变化',()=>{
  assert.equal(validate(glossary),glossary);
  assert.equal(termId('Thread'),'term-thread');
  assert.deepEqual([...glossary].reverse().map(row=>termId(row.term)).reverse(),glossary.map(row=>termId(row.term)));
});
for(const [name,change,error] of [
  ['未知阶段',rows=>{rows[0].stage='s99';},/Invalid glossary stage/],
  ['重复 term',rows=>{rows.push({...rows[0]});},/Duplicate glossary term/],
  ['失效 related',rows=>{rows[0].related.push('missing term');},/Unknown related term/],
  ['不存在的 source 文件',rows=>{rows[0].source='stages/missing.md#heading';},/Missing glossary source/],
  ['source 不能是目录',rows=>{rows[0].source='stages';},/Missing glossary source/],
  ['source 不能越界',rows=>{rows[0].source='../README.md';},/Invalid glossary source/],
  ['source 不能是 URL',rows=>{rows[0].source='https://example.com/file.md';},/Invalid glossary source/],
  ['锚点冲突',rows=>{rows.push({...rows[0],term:rows[0].term.toUpperCase()});},/glossary anchor/]
])test(`术语表校验拒绝${name}`,()=>{const rows=structuredClone(glossary);change(rows);assert.throws(()=>validate(rows),error);});

test('术语渲染转义所有文本；来源 URL 编码文件与标题',()=>{
  const term='A <B> & "C"', row={...glossary[0],term,aka:['<aka>'],short:'<short>',detail:'<script>alert(1)</script>',related:[term]};
  const html=renderGlossary([row],stages);
  for(const text of [term,...row.aka,row.short,row.detail])assert.ok(html.includes(escapeHtml(text)));
  assert.doesNotMatch(html,/<script>alert|<short>|<aka>/);
  assert.ok(html.includes(`href="#${termId(term)}"`));
  assert.equal(sourceUrl('stages/a b.md#Some Heading!'),'https://github.com/pengcong2020520/learn-codex-harness/blob/main/stages/a%20b.md#some-heading');
});

test('长文只改精确匹配的 term/aka，保留未匹配定义，解释正确转义',()=>{
  const row={...glossary[0],term:'A & B',aka:['别名'],short:'"解释" <内容> & 依据'};
  const html='<span class="term" data-definition="旧">A &amp; B</span> / <span class="term" data-definition="旧">别名</span> / <span class="term" data-definition="保留"> A &amp; B </span>';
  const linked=linkGlossaryTerms(html,[row]);
  assert.equal((linked.match(/href="\/course\/glossary.html#term-a-b"/g)||[]).length,2);
  assert.equal((linked.match(/data-definition="&quot;解释&quot; &lt;内容&gt; &amp; 依据"/g)||[]).length,2);
  assert.ok(linked.endsWith('<span class="term" data-definition="保留"> A &amp; B </span>'));
});

test('生成页面：阶段数据、最终请求路径、术语锚点与导航均来自数据',()=>{
  const overview=read('overview.html'),html=read('glossary.html'),changes=read('changes.html');
  assert.equal(html,renderGlossary(glossary,stages));
  const chapterStages=new Set(fs.readdirSync(new URL('modules/',course)).filter(file=>file.endsWith('.html')).map(file=>file.slice(0,3)));
  assert.equal(overview,renderOverview({stages,introduction,chapterStages}));
  assert.equal(introductionQuestions(introduction).length,6);
  assert.throws(()=>introductionQuestions(''),/六个问题/);
  for(const stage of stages){
    const panel=overview.split(`data-stage-panel="${stage.id}"`)[1].split('</section>')[0];
    assert.ok(panel.includes(escapeHtml(architecture[Number(stage.id.slice(1))].sub)));
    for(const module of stage.modules)assert.ok(panel.includes(escapeHtml(module.name)));
    for(const row of glossary.filter(row=>row.stage===stage.id))assert.ok(changes.split(`id="${stage.id}"`)[1].split('</section>')[0].includes(`/course/glossary.html#${termId(row.term)}`));
    assert.equal(panel.startsWith(' hidden'),stage.id!==stages.at(-1).id);
  }
  assert.equal(fs.readFileSync(new URL('assets/learning-roadmap.svg',course),'utf8'),fs.readFileSync(path.join(repository,'docs/images/learning-roadmap.svg'),'utf8'));
  const request=overview.split('<ol class="request-path">')[1].split('</ol>')[0];
  const firstAppearance=new Map();
  for(const stage of stages)for(const module of stageModules(Number(stage.id.slice(1))))if(!firstAppearance.has(module.id))firstAppearance.set(module.id,stage.id);
  const steps=[...request.matchAll(/<li>(.*?)<\/li>/g)].map(match=>match[1]);
  architecture[11].path.forEach(([id,label],index)=>{
    assert.ok(steps[index].includes(escapeHtml(label)));
    assert.ok(steps[index].includes(`#${id==='codex'?'s00':firstAppearance.get(id)}`));
  });
  assert.equal(steps.length,architecture[11].path.length);
  const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(ids.length,new Set(ids).size);
  for(const [,anchor] of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.includes(anchor));
  for(const name of ['index.html','handbook.html','changes.html'])for(const page of ['overview','glossary'])assert.ok(read(name).includes(`/course/${page}.html`));
  assert.match(read('index.html'),/第一次来？先看全景/);
  const workbench=fs.readFileSync(new URL('../public/app/main.js',import.meta.url),'utf8');
  for(const page of ['overview','glossary'])assert.ok(workbench.includes(`/course/${page}.html`));
});

test('生成页面符合 CSP，资源在本地，路线图副本与生成源一致',()=>{
  for(const name of ['overview.html','glossary.html']){
    const html=read(name);
    assert.doesNotMatch(html,/\son[a-z]+\s*=/i);
    assert.doesNotMatch(html,/<script(?![^>]*\ssrc=)/i);
    for(const [,resource] of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/g)){
      assert.ok(resource.startsWith('/course/'),resource);
      assert.ok(fs.existsSync(new URL(resource.slice('/course/'.length),course)),resource);
    }
  }
});

test('长文生成内容使用最新术语解释，源章节不需要手工改动',()=>{
  const html=read('handbook.html');
  let matches=0,untouched=0;
  for(const file of fs.readdirSync(new URL('modules/',course)).filter(file=>file.endsWith('.html'))){
    const source=read('modules/'+file),linked=linkGlossaryTerms(source,glossary);
    assert.ok(html.includes(linked.trimEnd()));
    matches+=(linked.match(/href="\/course\/glossary.html#/g)||[]).length;
    untouched+=(linked.match(/<span class="term"/g)||[]).length;
  }
  assert.ok(matches>0&&untouched>0);
});

test('全景默认已完成的 s17，增量从 s16 到 s17',()=>{
 assert.equal(stages.at(-1).id,'s17');
 assert.equal(stages.at(-1).previous,'s16-coordination');
 const overview=read('overview.html');
 assert.match(overview,/data-stage-panel="s17"(?! hidden)/);
 assert.match(overview,/<output[^>]*>s17<\/output>/);
 assert.match(overview,/\/course\/assets\/s17-architecture.svg/);
 assert.deepEqual(stages.at(-1).modules.map(m=>m.name),['用户分片']);
});
