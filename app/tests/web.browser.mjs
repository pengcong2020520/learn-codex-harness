import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, chrome, helpers } from './browser.mjs';
import { webFixture } from './web-fixture.mjs';

test('网页真实浏览器：登录、新建、流式回复、终态、重连、搜索、恢复、登出与错误密码', { timeout: 90000 }, async t => {
  assert.ok(chrome, '需要 Chrome；可用 CHROME_PATH 指定路径。');
  const fixture = await webFixture(t), page = await browser(t);
  await page.open(fixture.url + '/');
  assert.equal(await page.run('return location.pathname'), '/ui/');
  const security = await fetch(fixture.url + '/ui/');
  assert.match(security.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  await page.run(`document.querySelector('#username').value='alice';document.querySelector('#password').value='wrong';document.querySelector('#login-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('#notice').textContent.includes('用户名或密码错误'));`), true);
  assert.equal(await page.run(`return sessionStorage.getItem('agent.web.token')`), null);
  await page.run(`document.querySelector('#password').value='fixture-password';document.querySelector('#login-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#chat-view').hidden && $('#agent-name').textContent !== 'Agent', 10000);`), true);
  await page.run(`document.querySelector('#new-session').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#message').disabled, 10000);`), true);
  assert.equal(await page.run(`return document.querySelector('#model').textContent`), 'unit-model');
  // Observe a partial answer while the task is still running, before the final snapshot.
  await page.run(`document.querySelector('#message').value='浏览器测试消息';document.querySelector('#message').focus();`);
  await page.key('Enter', 13);
  assert.equal(await page.run(`${helpers} return await until(() => $$('.assistant').some(el => el.textContent.includes('mock') && el.dataset.status === 'running'), 10000);`), true, '应看到真实流式片段');
  assert.equal(await page.run(`${helpers} return await until(() => $$('.assistant').some(el => el.textContent.includes('mock reply turn-1') && el.dataset.status === 'completed'), 10000);`), true);
  assert.equal(fixture.requests.filter(r => r.path === '/messages' && r.method === 'POST').length, 1);
  assert.equal(fixture.requests.find(r => r.path === '/messages').origin, fixture.url);
  fixture.dropStreams();
  assert.equal(await page.run(`${helpers} return await until(() => !$('#connection').hidden);`), true);
  assert.equal(await page.run(`${helpers} return await until(() => $('#connection').hidden, 6000);`), true);
  assert.equal(await page.run(`return document.querySelectorAll('.assistant').length`), 1, '重连不重复回复');
  await page.run(`document.querySelector('#search').value='不存在的会话';document.querySelector('#search-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('#sessions').textContent.includes('暂无会话'));`), true);
  await page.run(`document.querySelector('#search').value='';document.querySelector('#search-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('.session-button'));`), true);
  await page.run(`document.querySelector('.session-button').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('.session-button').disabled && $('#messages').textContent.includes('mock reply turn-1'));`), true);
  assert.ok(fixture.requests.some(r => r.path === '/sessions/resume'));
  await page.viewport(390, 844);
  await page.run(`document.querySelector('#toggle-sidebar').click();`);
  assert.equal(await page.run(`return getComputedStyle(document.querySelector('#sidebar')).display`), 'flex');
  await page.run(`document.querySelector('#close-sidebar').click();`);
  assert.equal(await page.run(`return getComputedStyle(document.querySelector('#sidebar')).display`), 'none');
  await page.run(`document.querySelector('#logout').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#login-view').hidden);`), true);
  assert.equal(await page.run(`return sessionStorage.getItem('agent.web.token')`), null);
  assert.deepEqual(page.errors, [], '无 JS 异常或 console.error/warn');
  assert.ok(page.networkErrors.every(error => /401/.test(error) && /\/auth\/login/.test(error)), JSON.stringify(page.networkErrors));
});


test('网页 Workflow：等待确认 → 修改 → 重新执行 → 再次等待 → 继续', { timeout: 90000 }, async t => {
  assert.ok(chrome, '需要 Chrome；可用 CHROME_PATH 指定路径。');
  const workflows = [{ id: 'review', steps: [{ id: 'draft', goal: '写初稿', confirm: true }, { id: 'final', goal: '交付' }] }];
  const fixture = await webFixture(t, { workflows }), page = await browser(t);
  await page.open(fixture.url + '/ui/');
  await page.run(`document.querySelector('#username').value='alice';document.querySelector('#password').value='fixture-password';document.querySelector('#login-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#chat-view').hidden, 10000);`), true);
  await page.run(`document.querySelector('#new-session').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#message').disabled && $('.session-button[aria-current="true"]'), 10000);`), true);
  assert.equal(await page.run(`
    const threadId = document.querySelector('.session-button[aria-current="true"]').dataset.threadId;
    const response = await fetch('/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionStorage.getItem('agent.web.token') }, body: JSON.stringify({ threadId, clientMessageId: 'browser-revise', workflow: 'review', text: '页面任务' }) });
    return response.status;
  `), 202);
  assert.equal(await page.run(`${helpers} return await until(() => $$('.actions button').some(button => button.textContent === '修改'), 10000);`), true);
  assert.deepEqual(await page.run(`return [...document.querySelectorAll('.actions button')].map(button => button.textContent)`), ['继续', '修改', '结束']);
  assert.equal(await page.run(`return document.querySelector('#messages').textContent.includes('本步已重做 0 次')`), true);
  await page.run(`[...document.querySelectorAll('.actions button')].find(button => button.textContent === '修改').click();const input = document.querySelector('.message textarea');input.value='减少导航层级';input.dispatchEvent(new Event('input'));input.closest('form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $$('.user').some(row => row.dataset.status === 'running' && row.textContent.includes('页面任务')), 10000);`), true);
  assert.equal(await page.run(`${helpers} return await until(() => $('#messages').textContent.includes('本步已重做 1 次') && $$('.actions button').some(button => button.textContent === '继续'), 10000);`), true);
  assert.equal(fixture.requests.filter(r => r.path === '/tasks/revise' && r.method === 'POST').length, 1);
  assert.deepEqual(await page.run(`return [...document.querySelectorAll('.actions button')].map(button => button.textContent)`), ['继续', '修改', '结束']);
  assert.equal(await page.run(`return document.querySelector('#messages').textContent.includes('第 1 次按用户意见重做本步')`), true);
  await page.run(`[...document.querySelectorAll('.actions button')].find(button => button.textContent === '继续').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => $$('.user').some(row => row.dataset.status === 'completed' && row.textContent.includes('页面任务')), 10000);`), true);
  assert.equal(fixture.requests.filter(r => r.path === '/tasks/confirm' && r.method === 'POST').length, 1);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.networkErrors, []);
});

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

test('网页产物：脚本可点击运行、不透明来源与 CSP 拦截、图片可见、Markdown 纯文本和自动刷新', { timeout: 90000 }, async t => {
  assert.ok(chrome, '需要 Chrome；可用 CHROME_PATH 指定路径。');
  const fixture = await webFixture(t), page = await browser(t), workspace = fixture.app.runtime.workspaceDir;
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body style="margin:0">
    <button style="width:100%;height:80px" id="probe">点击验证</button><script>
    window.probe = { violations: [] };
    addEventListener('securitypolicyviolation', event => window.probe.violations.push(event.effectiveDirective));
    document.querySelector('#probe').onclick = async () => {
      document.querySelector('#probe').textContent = '脚本已运行';
      window.probe.text = document.querySelector('#probe').textContent;
      try { sessionStorage.getItem('agent.web.token'); window.probe.storage = 'unexpected'; } catch (error) { window.probe.storage = error.name + ': ' + error.message; }
      try { parent.document.body; window.probe.parent = 'unexpected'; } catch (error) { window.probe.parent = error.name + ': ' + error.message; }
      try { await fetch('/sessions'); window.probe.fetch = 'unexpected'; } catch (error) { window.probe.fetch = error.name + ': ' + error.message; }
      setTimeout(() => parent.postMessage({ previewProbe: window.probe }, '*'), 100);
    };
    </script></body></html>`;
  await mkdir(path.join(workspace, 'outputs/design'), { recursive: true });
  await writeFile(path.join(workspace, 'outputs/design/page.html'), html);
  await writeFile(path.join(workspace, 'outputs/picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(path.join(workspace, 'inputs/note.md'), '<script>window.markdownExecuted=true</script>\n# 原文');
  await page.open(fixture.url + '/ui/');
  await page.run(`document.querySelector('#username').value='alice';document.querySelector('#password').value='fixture-password';document.querySelector('#login-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $$('.artifact-file').length === 3, 10000);`), true);
  await page.run(`if (document.querySelector('#toggle-artifacts').getAttribute('aria-expanded') === 'false') document.querySelector('#toggle-artifacts').click();
    addEventListener('message', event => { if (event.source === document.querySelector('#artifact-preview iframe')?.contentWindow && event.data.previewProbe) window.previewProbe = event.data.previewProbe; });
    [...document.querySelectorAll('.artifact-file')].find(el => el.dataset.path.endsWith('page.html')).click();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('#artifact-preview iframe'));`), true);
  const sandbox = await page.run(`return document.querySelector('#artifact-preview iframe').getAttribute('sandbox')`);
  assert.equal(sandbox, 'allow-scripts allow-forms allow-modals');
  const previewUrl = await page.run(`return document.querySelector('#artifact-preview iframe').src`);
  assert.equal(await page.run(`return document.querySelector('#artifact-actions a').href`), previewUrl);
  // 先等待 iframe 加载，再以真实鼠标事件点击内联脚本绑定的按钮。
  await page.run(`await new Promise(resolve => { const frame=document.querySelector('#artifact-preview iframe'); frame.onload=resolve; setTimeout(resolve, 1000); });`);
  const point = await page.run(`const r=document.querySelector('#artifact-preview iframe').getBoundingClientRect();return {x:r.x+35,y:r.y+35};`);
  await page.clickAt(point.x, point.y);
  assert.equal(await page.run(`${helpers} return await until(() => window.previewProbe?.violations.includes('connect-src'));`), true);
  const probe = await page.run('return window.previewProbe');
  assert.equal(probe.text, '脚本已运行');
  assert.match(probe.storage, /SecurityError:.*(sandbox|origin)/i);
  assert.match(probe.parent, /SecurityError:.*(cross-origin|origin)/i);
  assert.match(probe.fetch, /^(TypeError|SecurityError):/);
  assert.equal(fixture.requests.filter(r => r.path === '/sessions').length, 0, 'CSP 在网络请求前拒绝 fetch');
  const issuanceCount = fixture.requests.filter(r => r.path === '/previews').length;
  await page.run(`document.querySelector('#artifact-actions button').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('#artifact-preview iframe')?.src !== ${JSON.stringify(previewUrl)});`), true);
  assert.equal(fixture.requests.filter(r => r.path === '/previews').length, issuanceCount + 1);
  await page.run(`[...document.querySelectorAll('.artifact-file')].find(el => el.dataset.path.endsWith('picture.png')).click();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('#artifact-preview img')?.naturalWidth === 1);`), true);
  await page.run(`[...document.querySelectorAll('.artifact-file')].find(el => el.dataset.path.endsWith('note.md')).click();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('#artifact-preview pre')?.textContent.includes('<script>'));`), true);
  assert.equal(await page.run(`return !!window.markdownExecuted || !!document.querySelector('#artifact-preview script')`), false);
  await page.run(`document.querySelector('#close-artifacts').click();document.querySelector('#new-session').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#message').disabled, 10000);`), true);
  await writeFile(path.join(workspace, 'outputs/new.txt'), '新产物');
  await page.run(`document.querySelector('#message').value='刷新产物';document.querySelector('#composer').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $$('.artifact-file').some(el => el.dataset.path === 'outputs/new.txt'), 10000);`), true);
  await page.viewport(390, 844);
  await page.run(`document.querySelector('#toggle-artifacts').click();`);
  assert.equal(await page.run(`return getComputedStyle(document.querySelector('#artifacts')).display`), 'flex');
  await page.run(`document.querySelector('#close-artifacts').click();`);
  assert.equal(await page.run(`return getComputedStyle(document.querySelector('#artifacts')).display`), 'none');
  // 同一地址直接导航，仍由响应 CSP 保持不透明来源。
  await page.open(previewUrl);
  await page.run(`document.querySelector('#probe').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => window.probe?.violations.includes('connect-src'));`), true);
  assert.match(await page.run('return window.probe.storage'), /SecurityError:.*(sandbox|origin)/i);
  assert.match(await page.run('return window.probe.fetch'), /^(TypeError|SecurityError):/);
  // 本机 Chrome 157 对同一次被拒的 connect 打两条 Log，不按整句文案区分：
  // security 是指令报告（含 connect-src）；javascript 是 Fetch 失败（Refused to connect）。
  // 两条正文都含 Content Security Policy。其余错误不放行。
  const expectedCsp = report => report.channel === 'log'
    && /Content Security Policy/i.test(report.text)
    && (
      (report.source === 'security' && (/connect-src/i.test(report.text) || /Refused to connect|Connecting to/i.test(report.text)))
      || (report.source === 'javascript' && /Refused to connect|Connecting to/i.test(report.text))
    );
  const expectedText = new Set(page.reports.filter(expectedCsp).map(report => report.text));
  assert.deepEqual(page.errors.filter(error => !expectedText.has(error)), []);
  assert.deepEqual(page.networkErrors.filter(error => !expectedText.has(error)), []);
});

import { TEST_IMAGE } from '../scripts/gateway-check.mjs';

test('网页上传：原始图片上传、标签移除与发送、Codex 收到图片项、inputs 产物预览', { timeout: 90000 }, async t => {
  assert.ok(chrome, '需要 Chrome；可用 CHROME_PATH 指定路径。');
  const fixture = await webFixture(t, { vision: true }), page = await browser(t), received = [];
  fixture.app.rpc.on('notification', message => {
    if (message.method === 'item/started' && message.params.item?.type === 'userMessage') received.push(message.params.item.content);
  });
  await page.beforeLoad(`window.FileReader = class { constructor() { throw new Error('页面不应通过 FileReader 读取图片'); } };`);
  await page.open(fixture.url + '/ui/');
  await page.run(`document.querySelector('#username').value='alice';document.querySelector('#password').value='fixture-password';document.querySelector('#login-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#chat-view').hidden, 10000);`), true);
  await page.run(`document.querySelector('#new-session').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#message').disabled, 10000);`), true);
  const upload = name => page.run(`
    const bytes = Uint8Array.from(atob(${JSON.stringify(TEST_IMAGE.split(',')[1])}), char => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' }));
    const input = document.querySelector('#upload-file'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  `);
  await upload('移除.png');
  assert.equal(await page.run(`${helpers} return await until(() => $('#attachments').textContent.includes('移除.png') && !$('#upload').disabled);`), true);
  await page.run(`document.querySelector('#attachments button').click();`);
  assert.equal(await page.run(`return document.querySelector('#attachments').children.length`), 0);
  await upload('参考图.png');
  assert.equal(await page.run(`${helpers} return await until(() => $('#attachments').textContent.includes('参考图.png'));`), true);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#upload').disabled);`), true);
  await page.run(`document.querySelector('#message').value='按参考图设计';document.querySelector('#composer').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $$('.assistant').some(row => row.dataset.status === 'completed'), 10000);`), true);
  assert.equal(await page.run(`return document.querySelector('#attachments').children.length`), 0);
  assert.deepEqual(received.flat().filter(item => item.type === 'image'), [{ type: 'image', url: TEST_IMAGE }]);
  const uploads = fixture.requests.filter(request => request.path.startsWith('/workspace/files'));
  assert.equal(uploads.length, 2); assert.ok(uploads.every(request => request.method === 'PUT' && request.origin === fixture.url));
  await page.run(`document.querySelector('#toggle-artifacts').click();document.querySelector('#refresh-artifacts').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('[data-path="inputs/uploads/参考图.png"]'));`), true);
  await page.run(`document.querySelector('[data-path="inputs/uploads/参考图.png"]').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('#artifact-preview img')?.naturalWidth === 8);`), true);
  assert.deepEqual(page.errors, []); assert.deepEqual(page.networkErrors, []);
});
