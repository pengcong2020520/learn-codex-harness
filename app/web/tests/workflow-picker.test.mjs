// 工作台对话页的 Workflow 选择器：用 ui-fixture（假上游，不调用模型）+ 无头 Chrome 实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {browser,helpers,chrome} from './browser.mjs';

async function fixture(t){
 const proc=spawn(process.execPath,[fileURLToPath(new URL('./ui-fixture.mjs',import.meta.url))],{env:{...process.env,UI_FIXTURE_PORT:'0'},stdio:['ignore','pipe','inherit']});
 const exited=new Promise(r=>proc.once('exit',r));t.after(async()=>{proc.kill('SIGTERM');await exited;});
 return new Promise((resolve,reject)=>{let text='';proc.stdout.on('data',d=>{text+=d;const m=text.match(/http:\/\/\S+/);if(m)resolve(m[0].replace(/\/$/,''));});proc.once('exit',code=>reject(Error(`fixture 退出：${code}`)));});
}
// 截图只用于人工自检：设置 WORKFLOW_SHOT_DIR 时保存。
const save=async(b,name)=>{const dir=process.env.WORKFLOW_SHOT_DIR;if(dir){await b.run("document.querySelector('#composer').scrollIntoView({block:'center'})");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/${name}.png`,Buffer.from(await b.shot(),'base64'));}};

test('Workflow 选择器：列出目录、按 schema 渲染参数、提交请求体正确、确认点可推进',{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await fixture(t),b=await browser(t);
 await b.open(url+'/?stage=project&view=run');
 const r=await b.run(`${helpers}
  const bodies=[];const original=window.fetch;window.fetch=(input,init)=>{if(String(input).endsWith('/messages'))bodies.push(JSON.parse(init.body));return original(input,init);};
  const out={};
  out.modes=await until(()=>$$('.compose-modes button').length===2);
  out.defaultChat=!$('#workflow-id');
  $('.compose-modes [data-mode="workflow"]').click();
  await until(()=>$('#workflow-id'));
  out.options=$$('#workflow-id option').map(o=>o.value);
  out.noParamsHint=$('.workflow-form').textContent.includes('不需要参数');
  out.steps=$$('.wf-steps .tag').length;
  const pick=id=>{$('#workflow-id').value=id;$('#workflow-id').dispatchEvent(new Event('change',{bubbles:true}));};
  const type=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
  // 必填参数为空时浏览器表单校验拦下，不发请求。
  pick('knowledge-maintain');await until(()=>$('[data-param="kbId"]'));
  type($('#message'),'整理新资料');$('#composer').requestSubmit();await sleep(200);out.blocked=bodies.length;
  // 枚举 + 文本参数。
  pick('brief');await until(()=>$('select[data-param="tone"]'));
  out.toneOptions=$$('select[data-param="tone"] option').map(o=>o.value);out.topicMax=$('input[data-param="topic"]').maxLength;
  $('select[data-param="tone"]').value='轻松';type($('input[data-param="topic"]'),'季度复盘');type($('#message'),'写一份简报');
  $('#composer').requestSubmit();await until(()=>bodies.length===1&&$$('.task-row').length===1,4000);
  // 多步 workflow：第 1 步后停在 waiting，确认后完成。
  await until(()=>!$('#message').disabled);
  out.modeKept=Boolean($('#workflow-id'));pick('write-article');await sleep(50);type($('#message'),'写一篇关于本地优先的文章');
  $('#composer').requestSubmit();await until(()=>$('[data-action="confirm-task"]'),4000);
  out.waiting=$$('.task-row').map(r=>r.textContent).find(t=>t.includes('write-article'));
  out.bodies=bodies.map(({workflow,params,text})=>({workflow,params,text}));
  return out;`);
 await save(b,'workflow-waiting');
 assert.ok(r.modes&&r.defaultChat,'默认是普通对话');
 assert.deepEqual(r.options,['write-article','knowledge-maintain','brief']);
 assert.ok(r.noParamsHint);assert.equal(r.steps,2);
 assert.equal(r.blocked,0,'必填参数为空时不提交');
 assert.deepEqual(r.toneOptions,['正式','轻松']);assert.equal(r.topicMax,40);
 assert.ok(r.modeKept,'提交后仍停在 Workflow 模式');
 assert.deepEqual(r.bodies,[{workflow:'brief',params:{tone:'轻松',topic:'季度复盘'},text:'写一份简报'},{workflow:'write-article',params:null,text:'写一篇关于本地优先的文章'}]);
 assert.match(r.waiting,/第 1\/2 步 outline/);assert.match(r.waiting,/waiting/);
 const done=await b.run(`${helpers}$('[data-action="confirm-task"]').click();await until(()=>!$('[data-action="confirm-task"]'),4000);return $$('.task-row .tag').map(t=>t.textContent);`);
 assert.deepEqual(done,['completed','completed']);
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});

test('教学演示模式：Workflow 选择器用内置样例，不调用 /messages，确认只改本页状态',{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await fixture(t),b=await browser(t);
 await b.open(url+'/?stage=project&view=run');
 const r=await b.run(`${helpers}
  const calls=[];const original=window.fetch;window.fetch=(input,init)=>{calls.push(String(input));return original(input,init);};
  await until(()=>$('[data-action="preview"]'));$('[data-action="preview"]').click();
  await until(()=>$('.compose-modes'));calls.length=0;
  $('.compose-modes [data-mode="workflow"]').click();await until(()=>$('#workflow-id'));
  const options=$$('#workflow-id option').map(o=>o.value);
  $('#message').value='示例文章';$('#composer').requestSubmit();
  await until(()=>$('[data-action="confirm-task"]'),3000);
  $('[data-action="confirm-task"]').click();await until(()=>!$('[data-action="confirm-task"]'));
  return {options,calls,tags:$$('.task-row .tag').map(t=>t.textContent),preview:Boolean($('.notice.preview'))};`);
 await save(b,'workflow-preview');
 assert.deepEqual(r.options,['write-article','knowledge-maintain']);
 assert.ok(r.preview);assert.deepEqual(r.calls.filter(c=>c.includes('/api/agent/')),[]);
 assert.deepEqual(r.tags,['completed']);
});
