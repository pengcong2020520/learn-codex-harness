// 工作台对话页的 Workflow 选择器：用 ui-fixture（假上游，不调用模型）+ 无头 Chrome 实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {browser,helpers,chrome} from './browser.mjs';

async function fixture(t,optionalStatus=''){
 const proc=spawn(process.execPath,[fileURLToPath(new URL('./ui-fixture.mjs',import.meta.url))],{env:{...process.env,UI_FIXTURE_PORT:'0',UI_FIXTURE_OPTIONAL_STATUS:optionalStatus},stdio:['ignore','pipe','inherit']});
 const exited=new Promise(r=>proc.once('exit',r));t.after(async()=>{proc.kill('SIGTERM');await exited;});
 return new Promise((resolve,reject)=>{let text='';proc.stdout.on('data',d=>{text+=d;const m=text.match(/http:\/\/\S+/);if(m)resolve(m[0].replace(/\/$/,''));});proc.once('exit',code=>reject(Error(`fixture 退出：${code}`)));});
}
// 截图只用于人工自检：设置 WORKFLOW_SHOT_DIR 时保存。
const save=async(b,name)=>{const dir=process.env.WORKFLOW_SHOT_DIR;if(dir){await b.run("document.querySelector('#composer').scrollIntoView({block:'center'})");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/${name}.png`,Buffer.from(await b.shot(),'base64'));}};

test('Workflow 选择器：列出目录、按 schema 渲染参数、提交请求体正确、确认点可推进',{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await fixture(t),b=await browser(t);
 await b.open(url+'/?stage=s11&view=run');
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
  // kbId：能拿到知识库列表就是下拉。
  pick('knowledge-maintain');await until(()=>$('[data-param="kbId"]'));
  out.kbSelect=$('[data-param="kbId"]').tagName+':'+$$('[data-param="kbId"] option').map(o=>o.value).join(',');
  out.noPatternAttr=!$('#composer [pattern]');
  // 枚举 + 文本参数。
  pick('brief');await until(()=>$('select[data-param="tone"]'));
  out.toneOptions=$$('select[data-param="tone"] option').map(o=>o.value);out.topicMax=$('input[data-param="topic"]').maxLength;
  $('select[data-param="tone"]').value='轻松';
  // 必填文本参数为空：浏览器原生校验拦下，不发请求。
  type($('#message'),'写一份简报');document.querySelector('#composer button[type=submit]').click();await sleep(200);
  out.requiredBlocked=bodies.length;out.valueMissing=$('input[data-param="topic"]').validity.valueMissing;
  // 不合规的编号：JS 按 u 标志校验，拦下并给提示。
  type($('input[data-param="topic"]'),'季度复盘');type($('input[data-param="code"]'),'9bad_ID');document.querySelector('#composer button[type=submit]').click();await sleep(200);
  out.patternBlocked=bodies.length;out.patternMessage=$('input[data-param="code"]').validationMessage;
  type($('input[data-param="code"]'),'');
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
 assert.equal(r.kbSelect,'SELECT:general','能拿到知识库列表时 kbId 渲染成下拉');assert.ok(r.noPatternAttr,'不输出会被 v 标志忽略的 pattern 属性');
 assert.equal(r.requiredBlocked,0,'必填参数为空时不提交');assert.ok(r.valueMissing,'出现原生必填提示');
 assert.equal(r.patternBlocked,0,'编号不合规时不提交');assert.match(r.patternMessage,/格式不符合要求/);
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
 await b.open(url+'/?stage=s11&view=run');
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

for(const status of ['404','401','403','503'])test(`第三轮 P2-1：可选快照 ${status} 保留诊断并转义展示，Workflow 仍可用`,{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await fixture(t,status),b=await browser(t);
 await b.open(url+'/?stage=s11&view=run');
 const label=status==='404'?'未提供：':'读取失败：';
 const reason=({'404':'当前目标未提供此接口。','401':'Agent 认证失败。','403':'无权读取此接口。','503':'尚未核验 Codex 记忆配置。'})[status];
 const result=await b.run(`${helpers}
  const ready=await until(()=>$('.compose-modes'));
  $('[data-tab="capabilities"]').click();
  const loaded=await until(()=>$('.runtime-tools')?.textContent.includes('FIXTURE_<DIAGNOSTIC>')&&$('.runtime-memory')?.textContent.includes('FIXTURE_<DIAGNOSTIC>'));
  const out={ready,loaded,tools:$('.runtime-tools').textContent,memory:$('.runtime-memory').textContent,images:$$('.runtime-tools img,.runtime-memory img').length};
  $('[data-tab="chat"]').click();await until(()=>$('.compose-modes'));
  $('[data-action="compose-mode"][data-mode="workflow"]').click();
  $('#message').value='可选能力失败后仍提交工作流';$('#composer').requestSubmit();
  out.submitted=await until(()=>$('[data-action="confirm-task"]'),4000);
  return out;`);
 assert.ok(result.ready&&result.loaded&&result.submitted);
 for(const text of [result.tools,result.memory]){
  assert.ok(text.includes(label));assert.ok(text.includes(reason));assert.ok(text.includes(`HTTP ${status}`));
  assert.ok(text.includes('FIXTURE_<DIAGNOSTIC>'));assert.ok(text.includes('<img data-diagnostic src=x onerror=alert(1)>'));
  if(status!=='404')assert.equal(text.includes('未提供：'),false);
 }
 assert.equal(result.images,0,'诊断里的 HTML 只能显示为文本');
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});
