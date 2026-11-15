import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { browser } from './browser.mjs';
import { walkthrough } from '../scripts/walkthrough.mjs';

test('真实 Chromium 采集画面、脱敏失败请求、慢请求及不可达状态，单文件走查页刷新保留原话', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'product-review-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    if (req.url === '/api/items?private=fixture-private') { res.writeHead(503); res.end(); return; }
    if (req.url === '/slow') { setTimeout(() => res.end('ok'), 2050); return; }
    res.setHeader('content-type', 'text/html'); res.end('<title>产品测试</title><h1>事项清单</h1><button>查询</button><script>document.querySelector("button").onclick=async()=>{console.error("fixture-private");await fetch("/api/items?private=fixture-private");await fetch("/slow");document.body.dataset.ready="yes"}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const plan = { schemaVersion: 1, projectId: 'demo', mode: 'product', round: 1, source: { artifact: 'build', version: 1 }, prd: 'prd.md', previousRound: null,
    confirmation: { status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedBy: '自动验收' },
    groups: [{ id: 'main', title: '查询', order: 1, screens: [{ id: 'items', title: '事项列表', position: 1, states: ['error','paid'], reproduce: { error: ['打开列表', '点击查询'], paid: ['进入付费流程'] },
      capture: { error: { steps: [{ open: '/' }, { click: 'button' }], ready: 'body[data-ready]' }, paid: { unavailableReason: '无付费测试账号。' } } }] }] };
  const planFile = path.join(root, 'plan-v1.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const { target, record } = await walkthrough({ planFile, baseUrl: 'http://127.0.0.1:' + server.address().port });
  const [screen, paid] = record.groups[0].screens[0].states;
  assert.match(screen.screenshot, /^data:image\/png;base64,iVBOR/); assert.ok(fs.existsSync(path.join(target, screen.screenshotPath)));
  assert.equal(paid.screenshot, null); assert.match(paid.unavailableReason, /付费/);
  for (const type of ['http', 'slow', 'console']) assert.ok(screen.diagnostics.some(d => d.type === type), type);
  assert.doesNotMatch(JSON.stringify(screen.diagnostics), /fixture-private|private=/);
  const portable = path.join(root, 'portable.html'); fs.copyFileSync(path.join(target, 'index.html'), portable);
  const page = await browser(t), url = pathToFileURL(portable).href;
  await page.open(url);
  assert.equal(await page.run('const i=document.querySelector(".shot img");await i.decode();return i.naturalWidth'), 1440);
  await page.run('const e=document.querySelector("textarea");e.value="真实原话";e.dispatchEvent(new Event("input"));document.querySelector(".marks button").click()');
  await page.open(url);
  assert.equal(await page.run('return document.querySelector("textarea").value'), '真实原话');
  assert.equal(await page.run('return document.querySelector(".marks button").getAttribute("aria-pressed")'), 'true');
  await assert.rejects(walkthrough({ planFile, baseUrl: 'http://127.0.0.1' }), /已采集/);
});
