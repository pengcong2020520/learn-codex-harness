// 阶段演示页（/course/changes.html）：静态检查 + 无头 Chrome 实测机制动画。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../server.mjs';
import {browser,helpers,chrome} from './browser.mjs';

async function workbench(t){const app=createWorkbench({port:0,targets:[]});const url=await app.listen();t.after(()=>app.close());return url;}

test('阶段演示页：没有内联脚本，不再列代码行数，s00–s02、s08–s11 有机制演示',async t=>{
 const url=await workbench(t);const html=await (await fetch(url+'/course/changes.html')).text();
 assert.doesNotMatch(html,/\son[a-z]+=/i);assert.doesNotMatch(html,/<script(?![^>]*\ssrc=)/);
 assert.doesNotMatch(html,/行数|chg-bar|改动文件/);
 for(const id of ['s00','s01','s02','s08','s09','s10','s11'])assert.match(html,new RegExp(`<section class="chg-stage" id="${id}">[\\s\\S]*?<article class="mech"`));
 assert.equal((await fetch(url+'/course/demos.js')).status,200);
});

test('机制动画：下一步高亮源码、送出消息、更新状态；上一步能回退；最后显示结论',{skip:!chrome&&'没有找到 Chrome（可设 CHROME_PATH）'},async t=>{
 const url=await workbench(t),b=await browser(t);
 await b.open(url+'/course/changes.html');
 const r=await b.run(`${helpers}
  const m=$('#s00 .mech'),next=$('[data-do="next"]',m),prev=$('[data-do="prev"]',m),state=k=>$('.mech-state [data-key="'+k+'"] dd',m).textContent;
  const out={start:state('Codex 进程'),prevDisabled:prev.disabled};
  next.click();out.hl=$$('.mech-code li.on',m).map(li=>li.dataset.line);
  for(let i=0;i<3;i++)next.click();
  await sleep(1200);
  out.proc=state('Codex 进程');out.codex=$('.lane-head[data-actor="codex"] small',m).textContent;out.packet=$('.msg.now .label',m).textContent;out.packetShown=!$('.msg.now',m).hidden;out.dimBefore=null;
  out.changed=$('.mech-state [data-key="Codex 进程"]',m).classList.contains('changed');
  prev.click();out.back=state('Codex 进程');
  while(!next.disabled)next.click();
  out.end=state('Codex 进程');out.takeaway=!$('.mech-takeaway',m).hidden;out.count=$('.mech-count',m).textContent;
  return out;`);
 assert.equal(r.start,'0 个');assert.ok(r.prevDisabled);
 assert.deepEqual(r.hl,['4']);
 assert.equal(r.proc,'1 个');assert.equal(r.codex,'运行中');assert.equal(r.packet,'启动 codex exec 子进程');assert.ok(r.packetShown&&r.changed);
 assert.equal(r.back,'0 个','回退后状态也要回到上一步');
 assert.equal(r.end,'0 个');assert.ok(r.takeaway);assert.match(r.count,/^(\d+) \/ \1$/);
 assert.deepEqual(b.errors.filter(e=>!e.includes('favicon')),[]);
});
