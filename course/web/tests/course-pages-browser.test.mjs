import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorkbench} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';
import {termId} from '../course-data.mjs';

const glossary=JSON.parse(fs.readFileSync(new URL('../curriculum/glossary.json',import.meta.url),'utf8'));
const {stages}=JSON.parse(fs.readFileSync(new URL('../../../stages/changes.json',import.meta.url),'utf8'));
const options={skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'};
async function setup(t){const app=createWorkbench({port:0,targets:[]});const url=await app.listen();t.after(()=>app.close());return {url,b:await browser(t)};}
const noErrors=b=>assert.deepEqual(b.errors.filter(error=>!error.includes('favicon')),[],'没有脚本错误或 CSP 拦截');

test('全景：默认最新阶段，滑块切到 s05；图高稳定、刻度和原生键盘可操作',options,async t=>{
  const {url,b}=await setup(t);await b.open(url+'/course/overview.html',{reduceMotion:true});
  const initial=await b.run(`${helpers}const panel=$('[data-stage-panel]:not([hidden])');return {id:panel.dataset.stagePanel,height:$('.architecture-frame',panel).getBoundingClientRect().height,next:$('#stage-next').disabled};`);
  assert.equal(initial.id,stages.at(-1).id);assert.ok(initial.next);
  const index=stages.findIndex(stage=>stage.id==='s05');
  const changed=await b.run(`${helpers}const slider=$('#stage-slider');slider.value=${index};slider.dispatchEvent(new Event('input',{bubbles:true}));slider.focus();const panel=$('[data-stage-panel]:not([hidden])');return {id:panel.dataset.stagePanel,src:$('img',panel).getAttribute('src'),loaded:$('img',panel).naturalWidth>0,modules:$$('.overview-modules b',panel).map(el=>el.textContent),height:$('.architecture-frame',panel).getBoundingClientRect().height,tick:$('[data-stage-index="${index}"]').getAttribute('aria-pressed')};`);
  assert.equal(changed.id,'s05');assert.equal(changed.src,'/course/assets/s05-architecture.svg');assert.ok(changed.loaded);assert.equal(changed.tick,'true');
  assert.deepEqual(changed.modules,stages[index].modules.map(module=>module.name));assert.equal(changed.height,initial.height);
  await b.key('ArrowLeft',37);
  assert.equal(await b.run(`${helpers}return $('[data-stage-panel]:not([hidden])').dataset.stagePanel;`),'s04');
  await b.key('ArrowRight',39);
  assert.equal(await b.run(`${helpers}return $('[data-stage-panel]:not([hidden])').dataset.stagePanel;`),'s05');
  await b.key('Home',36);
  assert.equal(await b.run(`${helpers}return $('#stage-prev').disabled;`),true);
  await b.key('End',35);
  assert.equal(await b.run(`${helpers}return $('#stage-next').disabled;`),true);
  const buttons=await b.run(`${helpers}$('[data-stage-index="${index}"]').click();$('#stage-next').click();const next=$('[data-stage-panel]:not([hidden])').dataset.stagePanel;$('#stage-prev').click();return {next,prev:$('[data-stage-panel]:not([hidden])').dataset.stagePanel};`);
  assert.deepEqual(buttons,{next:'s06',prev:'s05'});
  await b.viewport(390,844);
  assert.equal(await b.run('return document.documentElement.scrollWidth<=innerWidth;'),true);
  noErrors(b);
});

test('术语表：Thread 只显示 term/aka/short 匹配项，s04 筛选、空状态和跨阶段锚点',options,async t=>{
  const {url,b}=await setup(t);await b.open(url+'/course/glossary.html');
  const results=await b.run(`${helpers}$('#glossary-search').value='Thread';$('#glossary-search').dispatchEvent(new Event('input',{bubbles:true}));return $$('.term-card:not([hidden])').map(card=>card.id);`);
  assert.deepEqual(results,glossary.filter(row=>[row.term,...row.aka,row.short].join('\n').toLowerCase().includes('thread')).map(row=>termId(row.term)));
  const filtered=await b.run(`${helpers}$('#glossary-search').value='';$('#glossary-search').dispatchEvent(new Event('input'));$('[data-filter="s04"]').click();return {groups:$$('[data-group]:not([hidden])').map(group=>group.dataset.group),cards:$$('.term-card:not([hidden])').map(card=>card.id)};`);
  assert.deepEqual(filtered.groups,['s04']);assert.deepEqual(filtered.cards,glossary.filter(row=>row.stage==='s04').map(row=>termId(row.term)));
  const origin=glossary.find(row=>row.stage==='s04'&&row.related.some(term=>glossary.find(item=>item.term===term).stage!=='s04'));
  const destination=origin.related.find(term=>glossary.find(row=>row.term===term).stage!=='s04');
  const linked=await b.run(`${helpers}const card=$('#${termId(origin.term)}');$('details',card).open=true;$('a[href="#${termId(destination)}"]',card).click();await until(()=>location.hash==='#${termId(destination)}'&&!$('#${termId(destination)}').hidden);const target=$('#${termId(destination)}');return {visible:!target.hidden&&!target.closest('[data-group]').hidden,open:$('details',target).open,focused:document.activeElement===target};`);
  assert.deepEqual(linked,{visible:true,open:true,focused:true});
  assert.equal(await b.run(`${helpers}$('#glossary-search').value='no-such-term-xyz';$('#glossary-search').dispatchEvent(new Event('input'));return !$('#glossary-empty').hidden&&$$('[data-group]:not([hidden])').length===0;`),true);
  // Same path + new hash is a same-document navigation without load; force a real load.
  await b.open(url+'/course/glossary.html?direct=1#term-thread');
  assert.equal(await b.run(`${helpers}return $('#term-thread details').open;`),true);
  await b.viewport(390,844);
  assert.equal(await b.run('return document.documentElement.scrollWidth<=innerWidth;'),true);
  noErrors(b);
});

test('长文：匹配术语的真实鼠标悬停显示 glossary.short，并可进入对应术语',options,async t=>{
  const {url,b}=await setup(t);await b.open(url+'/course/handbook.html',{reduceMotion:true});
  const selector='a.term[href="/course/glossary.html#term-thread"]';
  await b.hover(selector);
  const tip=await b.run(`${helpers}await until(()=>!$('#term-tip').hidden);const term=$(${JSON.stringify(selector)});return {text:$('#term-tip').textContent,definition:term.dataset.definition,shown:!$('#term-tip').hidden};`);
  const short=glossary.find(row=>row.term==='Thread').short;
  assert.deepEqual(tip,{text:short,definition:short,shown:true});
  await b.clickNavigate(selector);
  assert.equal(await b.run(`${helpers}return location.pathname==='/course/glossary.html'&&location.hash==='#term-thread'&&$('#term-thread details').open;`),true);
  noErrors(b);
});
