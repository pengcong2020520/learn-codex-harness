import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browser, chrome, helpers } from './browser.mjs';
import { studioWebFixture } from './studio-web-fixture.mjs';
import { collectLayout, checkLayout, checkDesign } from '../scripts/layout-check.mjs';
import { TEST_IMAGE } from '../scripts/gateway-check.mjs';
const read = name => fs.readFileSync(new URL(`./fixtures/studio/${name}`, import.meta.url), 'utf8');
const wait = (page, expression) => page.run(`${helpers} return await until(() => ${expression}, 10000);`).then(ok => assert.equal(ok, true, expression));
const click = (page, label) => page.run(`const button = [...document.querySelectorAll('button')].find(node => node.textContent === ${JSON.stringify(label)} && !node.disabled && node.checkVisibility()); if (!button) throw Error('按钮不可用：'+${JSON.stringify(label)}); button.click();`);
async function login(page, fixture, user = 'alice') {
  const token = await fixture.login(user);
  await page.beforeLoad(`if (window === window.top && location.origin === ${JSON.stringify(fixture.url)}) {
    sessionStorage.setItem('agent.web.token', ${JSON.stringify(token)});
    window.cspViolations = [];
    addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.effectiveDirective));
  }`);
  await page.open(fixture.url + '/app/');
}
async function upload(page, target, names) {
  await page.run(`const transfer = new DataTransfer(); const bytes = Uint8Array.from(atob(${JSON.stringify(TEST_IMAGE.split(',')[1])}), c => c.charCodeAt(0));
    for (const name of ${JSON.stringify(names)}) transfer.items.add(new File([bytes], name, {type:'image/png'}));
    const input = document.querySelector('[data-upload="${target}"]');input.files=transfer.files;input.dispatchEvent(new Event('change'));`);
  await wait(page, `document.querySelectorAll('[data-attachments="${target}"] .attachment').length === ${names.length}`);
}

function checkpoints(t, page, reports = [], shots = [], reportName = 'verification.json') {
  const shotDir = process.env.STUDIO_SHOTS_DIR;
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
  t.after(() => { if (shotDir) fs.writeFileSync(path.join(shotDir, reportName), JSON.stringify({ reports, shots }, null, 2)); });
  return async (name, { dark = false, oneScreen = false, themeConfirm = false } = {}) => {
    for (const [width, height] of [[1440, 900], [1280, 720]]) {
      await page.viewport(width, height);
      await page.run('await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));');
      const snapshot = await page.run(`return (${collectLayout.toString()})();`);
      const issues = checkLayout(snapshot);
      const small = snapshot.elements.filter(item => item.visible && item.ownText && item.text && item.fontSize < 12);
      reports.push({ name, width, height, issues, small });
      assert.deepEqual(issues, [], `${name} ${width}×${height}: ${JSON.stringify(issues)}`);
      assert.deepEqual(small, [], `${name} 有小于 12px 的文字`);
      assert.equal(await page.run('return document.documentElement.scrollHeight <= innerHeight'), true, `${name} 整页不可滚动`);
      if (oneScreen) assert.equal(await page.run('const view=document.querySelector(".view"); return view.scrollHeight <= view.clientHeight;'), true, `${name} ${width}×${height} 区域不可滚动`);
      if (themeConfirm) {
        assert.equal(await page.run(`const button=[...document.querySelectorAll('button')].find(node=>node.textContent==='确认，生成高保真');
          const r=button.getBoundingClientRect(),chat=document.querySelector('#chat').getBoundingClientRect();
          return button.checkVisibility() && r.top>=chat.top && r.bottom<=chat.bottom && r.left>=chat.left && r.right<=chat.right && document.querySelector('#messages').scrollTop===0;`), true, '主题确认按钮无需滚动就完全可见');
      }
      if (shotDir) {
        const file = width === 1440 ? `${name}.png` : `${name}-${width}x${height}.png`;
        fs.writeFileSync(path.join(shotDir, file), Buffer.from(await page.shot(), 'base64')); shots.push(file);
      }
    }
    await page.viewport(1440, 900);
    if (shotDir && dark) {
      await page.colorScheme('dark'); await page.run('await new Promise(resolve => requestAnimationFrame(resolve));');
      const file = `${name}-dark.png`; fs.writeFileSync(path.join(shotDir, file), Buffer.from(await page.shot(), 'base64')); shots.push(file);
      await page.colorScheme('light');
    }
  };
}

// 验证真实操作路径，并在每个检查点使用同一布局采样器；无需给正式 UI 加绕过鉴权的测试入口。
test('Studio 浏览器：欢迎到复制指令，真实 feedback 分流、两轮澄清、换主题、结构确认、CSP 与双尺寸布局', { timeout: 180000 }, async t => {
  assert.ok(chrome, '需要 Chrome；请在允许监听端口的环境设置 CHROME_PATH 后运行。');
  const fixture = await studioWebFixture(t), page = await browser(t), reports = [], shots = [];
  const checkpoint = checkpoints(t, page, reports, shots);
  await login(page, fixture); await wait(page, `$('#main').dataset.screen === 'web-p1'`); await checkpoint('01-welcome');
  await click(page, '开始设计'); await wait(page, `Boolean($('#brief-form'))`); await checkpoint('02-brief', { oneScreen: true });
  await page.run(`const transfer=new DataTransfer();transfer.items.add(new File(['bad'],'bad.exe'));const input=document.querySelector('[data-upload="brief"]');input.files=transfer.files;input.dispatchEvent(new Event('change'));`);
  await wait(page, `Boolean($('#brief-form .error-status'))`); await checkpoint('02-brief-error', { oneScreen: true });
  await page.run(`document.querySelector('.error-status button').click()`);
  await page.run(`for (const [name,value] of Object.entries({name:'task-helper',positioning:'帮助个人整理每日事项',platforms:'Web',audience:'个人',coreTasks:'整理事项、确认后保存'})) {const input=document.querySelector('[name="'+name+'"]');input.value=value;input.dispatchEvent(new Event('input'));}`);
  await upload(page, 'brief', ['参考一.png', '参考二.png']); await checkpoint('03-brief-attached', { oneScreen: true });
  await click(page, '提交资料卡'); await fixture.started(1);
  assert.equal(fixture.rpc.calls.find(call => call.method === 'turn/start').params.input.filter(item => item.type === 'image').length, 2);
  await fixture.produce(['clarify-r1.json'], 0); await wait(page, `Boolean($('#clarify-form'))`); await checkpoint('04-clarify-r1');
  await page.run(`document.querySelector('#clarify-form input[type=radio]').click()`); await click(page, '提交'); await fixture.started(2);
  assert.equal(JSON.parse(fixture.files.read_draft({ name: 'clarify.json' }).content).round, 1);
  await fixture.produce(['clarify-r2.json'], 0); await wait(page, `$('#clarify-form')?.textContent.includes('第 2 / 3 轮')`); await checkpoint('05-clarify-r2');
  await page.run(`document.querySelector('#clarify-form input[type=radio]').click()`); await click(page, '提交'); await fixture.started(3);
  await fixture.produce(['clarify-r3.json', 'brief-v1.md'], 0); await fixture.started(4);
  await fixture.produce(['prd-v1.md', 'decisions-v2.json'], 1); await wait(page, `Boolean($('.doc h1')) && $('#main').dataset.screen === 'web-s3'`); await checkpoint('06-prd', { dark: true });
  await page.run(`document.querySelector('.chat-menu').open=true`); await checkpoint('06-prd-menu');
  await page.run(`document.querySelector('.chat-menu').open=false`);
  await click(page, '确认，进入下一步'); await fixture.started(5);
  await wait(page, `$('#main').dataset.state === 'loading'`);
  await page.run(`document.querySelector('#chat-input').value='生成时保持个人使用范围';document.querySelector('#chat-input').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit();`);
  await wait(page, `$('#messages').textContent.includes('已加入当前生成')`);
  assert.ok(fixture.rpc.calls.some(call => call.method === 'turn/steer'));
  assert.ok(fixture.responses.some(response => response.body.mode === 'steer'));
  await fixture.produce(['wireframe-v1.html'], 2); await wait(page, `Boolean($('#preview'))`); await checkpoint('07-lofi');
  assert.match(await page.run(`return document.querySelector('.context').textContent`), /事项列表.*默认/);
  await page.run(`const buttons=[...document.querySelectorAll('.dir-states button')]; buttons.find(node=>node.textContent==='失败').click();`);
  assert.match(await page.run(`return document.querySelector('#preview').src`), /screen=web-create&state=error/); await checkpoint('08-lofi-state');
  await page.run(`document.querySelector('#chat-input').value='失败状态请说清恢复方式';document.querySelector('#chat-input').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit();`);
  await fixture.started(6); assert.equal(fixture.responses.at(-1).body.mode, 'revise');
  await wait(page, `$('#main').dataset.state === 'loading' && Boolean($('#preview')) && Boolean($('.thinking'))`);
  await page.run(`document.querySelector('.thinking').open=true`); await checkpoint('18-generating');
  const previousPreview = await page.run(`return document.querySelector('#preview').src`);
  assert.match(previousPreview, /screen=web-create&state=error/);
  assert.equal(await page.run(`return Boolean(document.querySelector('#center > .progress-inline')) && document.querySelector('#directory').textContent.includes('生成中')`), true);
  const task = fixture.store.state.jobs.find(job => job.workflow === 'design' && job.mode !== 'append');
  fixture.rpc.finish(task.threadId, 'failed');
  await wait(page, `$('#main').dataset.state === 'error' && $('#messages').textContent.includes('重新生成')`);
  const failedPreview = await page.run(`return document.querySelector('#preview').src`);
  const artifact = url => { const claim = JSON.parse(Buffer.from(new URL(url).pathname.slice('/preview/'.length).split('.')[0], 'base64url')); return { path: claim.path, sha256: claim.sha256, hash: new URL(url).hash }; };
  assert.deepEqual(artifact(failedPreview), artifact(previousPreview));
  assert.equal(await page.run(`return document.querySelector('#messages').textContent.includes('上一版预览保持不变')`), true);
  await checkpoint('19-failed');
  await page.run(`const input=document.querySelector('#chat-input');input.value='失败后意见';input.dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit();`);
  await wait(page, `Boolean($('#messages .error-status'))`); await checkpoint('19-failed-error');
  assert.equal(await page.run(`return document.querySelector('#chat-input').value`), '失败后意见');
  await page.run(`document.querySelector('.error-status button').click()`);
  await page.run(`const input=document.querySelector('#chat-input'); input.value='核对后重新生成，保留上一版';input.dispatchEvent(new Event('input'));`);
  await click(page, '重新生成'); await fixture.started(7);
  assert.deepEqual(fixture.requests.find(request => request.path === '/tasks/retry').body, { threadId: task.threadId, taskId: task.id, text: '核对后重新生成，保留上一版' });
  assert.equal(fixture.responses.find(response => response.path === '/tasks/retry').body.status, 'queued');
  assert.equal(task.step, 2); assert.equal(task.reviseCount, 2);
  await fixture.produce(['wireframe-v2.html'], 2, 'waiting', { 'wireframe-v2.html': read('wireframe-v1.html') });
  await wait(page, `$('#preview')?.src.includes('/preview/') && $('#main').dataset.state === 'default'`);
  await click(page, '确认，进入下一步'); await wait(page, `$('#main').dataset.state === 'ask-reference'`); await checkpoint('09-theme-reference');
  assert.equal(await page.run(`return document.querySelector('#directory').textContent`), '主题等待选项');
  assert.equal(await page.run(`return document.querySelector('.context').textContent`), '当前：主题×');
  await click(page, '不用，直接出选项'); await fixture.started(8);
  await fixture.produce(['themes-r1.json', 'theme-sample-v1.html', 'theme-sample-v2.html', 'theme-sample-v3.html'], 3);
  await wait(page, `document.querySelectorAll('.choice-option').length === 6`); await checkpoint('10-theme-choices');
  assert.deepEqual(await page.run(`return [...document.querySelectorAll('#directory button')].map(node=>node.textContent)`), ['样页 · 事项列表', '样页 · 输入事项']);
  await click(page, '样页 · 输入事项'); assert.match(await page.run(`return document.querySelector('#preview').src`), /screen=web-create&state=default/);
  assert.equal(await page.run(`return document.querySelector('.context').textContent`), '当前：主题×');
  await page.run(`document.querySelector('[data-kind="theme"] .choice-option').click();document.querySelector('[data-kind="style"] button:last-child').click();`);
  await fixture.started(9); assert.equal(fixture.responses.at(-1).body.mode, 'revise');
  const themes = JSON.parse(read('themes-r1.json')); themes.round = 2;
  for (const item of themes.styles) {
    item.id = item.id.replace('r1-', 'r2-'); item.name += '新版'; item.tokens['--radius-sm'] = '6px';
    themes.shown.push(item.id); themes.shownHistory.push({ kind: 'style', ...item });
  }
  for (const sample of themes.samples) sample.styleId = sample.styleId.replace('r1-', 'r2-');
  await fixture.produce(['themes-r2.json'], 3, 'waiting', { 'themes-r2.json': JSON.stringify(themes) });
  await wait(page, `document.querySelectorAll('.choice-option').length === 6 && $('[data-choice="r2-style-1"]')`);
  await page.run(`document.querySelector('[data-choice="r2-style-1"]').click();`);
  assert.match(await page.run(`return document.querySelector('#preview').src`), /theme=/);
  await wait(page, `$('#theme-choices').textContent.includes('确认，生成高保真')`); await checkpoint('11-theme-selected', { themeConfirm: true });
  await click(page, '确认，生成高保真'); await fixture.started(10);
  const themeDraft = JSON.parse(fixture.files.read_draft({ name: 'theme.json' }).content);
  assert.equal(themeDraft.styleRound, 2); assert.equal(themeDraft.themeRound, 1);
  // 此路径只验证前端与任务编排；固定样例不冒充模型按新候选真实创作。
  await fixture.produce(['prototype-v1.html', 'structure-changes-v1.json'], 4);
  await wait(page, `$('#main').dataset.screen === 'web-s6' && Boolean($('#preview'))`);
  await page.run(`document.querySelector('#chat-input').value='把确认操作固定到底部';document.querySelector('#chat-input').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit();`);
  await fixture.started(11);
  await fixture.produce(['structure-changes-v2.json'], 4, 'waiting', { 'structure-changes-v2.json': read('structure-changes-proposed-v2.json') });
  await wait(page, `Boolean($('.structure'))`); await checkpoint('12-structure-review');
  assert.equal(await page.run(`return [...document.querySelectorAll('button')].find(node=>node.textContent==='按决定生成').disabled`), true);
  await click(page, '同意'); await click(page, '按决定生成'); await fixture.started(12);
  assert.equal(JSON.parse(fixture.files.read_draft({ name: 'structure-changes.json' }).content).items[0].decision, 'accept');
  const resolved = JSON.parse(read('structure-changes-v1.json')); resolved.version = 3; resolved.prototype = 'prototype-v2.html';
  await fixture.produce(['prototype-v2.html', 'structure-changes-v3.json'], 4, 'waiting', { 'structure-changes-v3.json': JSON.stringify(resolved) });
  await wait(page, `Boolean($('#preview')) && $('#messages').textContent.includes('确认，生成代码')`); await checkpoint('13-hifi', { dark: true });
  fixture.dropStreams(); await wait(page, `Boolean($('#connection')) && !$('#connection').hidden`); await wait(page, `$('#connection').hidden`);
  await click(page, '确认，生成代码'); await fixture.started(13);
  assert.match(fixture.rpc.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text, /步：package/);
  await fixture.produce(fixture.packageFiles(), 5, 'completed'); await wait(page, `$('#main').dataset.screen === 'web-s7' && $('#main').dataset.state === 'complete'`); await checkpoint('14-package', { oneScreen: true });
  assert.equal(await page.run(`return !document.querySelector('#chat-input') && !document.querySelector('.context') && document.querySelector('#chat').textContent.includes('设计已完成')`), true);
  assert.equal(await page.run(`return document.querySelector('.package-doc').textContent.includes('agent:check：通过 · 0 个错误') && document.querySelector('.tree').textContent.includes('个设计记录')`), true);
  await click(page, '查看落地指令'); await wait(page, `Boolean($('#copy-prompt'))`); await checkpoint('15-handoff');
  assert.deepEqual(await page.run(`return [...document.querySelectorAll('.land-progress b')].map(node => node.textContent)`),
    ['落地', '开发', '本机运行', '巡查', '修复', '部署']);
  await page.run(`window.copiedPrompt=null;Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copiedPrompt=value}}});`);
  await click(page, '复制指令'); assert.equal(await page.run('return window.copiedPrompt'), read('package-v1/PROMPT.md'));
  await click(page, '部署手册'); await wait(page, `$('.doc').textContent.includes('部署')`); await checkpoint('16-deploy');
  await click(page, '版本历史'); await wait(page, `Boolean($('.drawer'))`); await checkpoint('17-history');
  assert.equal(await page.run(`const drawer=document.querySelector('.drawer');return !/prd-v|prototype-v|\\.html|\\.json/.test(drawer.textContent) && drawer.textContent.includes('已确认') && /\\d{2}:\\d{2}/.test(drawer.textContent) && drawer.querySelector('.history-group').dataset.stage==='5';`), true);
  await page.run(`document.querySelector('[data-version="prd-v1.md"]').click()`); await wait(page, `$('#main').dataset.state === 'history-readonly'`);
  assert.equal(await page.run(`return document.querySelector('#chat-input').disabled`), true);
  assert.deepEqual(await page.run('return window.cspViolations'), []);
  assert.deepEqual(page.reports.filter(report => report.channel === 'log' && report.source === 'security'), []);
  assert.deepEqual(page.errors, []);
  assert.ok(fixture.requests.filter(request => request.path.startsWith('/workspace/files')).every(request => request.method === 'PUT'));
  assert.equal(fixture.requests.filter(request => request.path === '/tasks/revise').length, 0);
  assert.ok(fixture.requests.length <= 200, `全流程请求 ${fixture.requests.length} 次，预算为 200 次`);
  t.diagnostic(`全流程请求总数：${fixture.requests.length}`);
});

test('Studio 浏览器：普通用户 P9、他人占用摘要与二次确认，真实 workflow 接管与 409 原文提示', { timeout: 90000 }, async t => {
  assert.ok(chrome);
  const fixture = await studioWebFixture(t), page = await browser(t);
  const checkpoint = checkpoints(t, page, [], [], 'verification-access.json');
  await login(page, fixture, 'bob'); await wait(page, `$('#main').textContent.includes('产品设计中')`); await checkpoint('20-p9');
  fixture.users.users[1].role = 'admin';
  fixture.hubState.users.find(user => user.id === '22222222-2222-4222-8222-222222222222').role = 'admin';
  const occupant = { id: 'other-task', userId: '22222222-2222-4222-8222-222222222222', threadId: 'other-thread', single: true, workflow: 'design', status: 'waiting', createdAt: Date.now(), username: '另一位管理员', text: '待确认的设计任务', mode: 'enqueue' };
  fixture.store.state.jobs.push(occupant);
  await login(page, fixture); await wait(page, `$('#main').textContent.includes('另一位管理员')`); await checkpoint('21-readonly');
  await click(page, '结束他人占用任务'); assert.equal(await page.run(`return document.querySelector('#dialog').open`), true);
  assert.equal(fixture.requests.filter(request => request.path === '/tasks/cancel').length, 0);
  await click(page, '取消'); assert.equal(await page.run(`return document.querySelector('#dialog').open`), false);
  assert.equal(fixture.requests.filter(request => request.path === '/tasks/cancel').length, 0);
  await click(page, '结束他人占用任务'); await checkpoint('22-takeover-confirm');
  const startedAt = occupant.createdAt; occupant.createdAt++;
  await click(page, '确认接管'); await wait(page, `$('#dialog').textContent.includes('占用已变化，请刷新后核对')`);
  assert.equal(occupant.status, 'waiting'); await checkpoint('22-takeover-error');
  occupant.createdAt = startedAt;
  await click(page, '确认接管'); await wait(page, `$('#main').dataset.screen === 'web-p1'`);
  assert.equal(occupant.status, 'cancelled');
  assert.deepEqual(fixture.requests.filter(request => request.path === '/tasks/cancel').map(request => request.body), Array(2).fill({ workflow: 'design', startedAt, takeover: true }));
  assert.ok(fixture.requests.filter(request => request.path === '/workbench').length >= 3);
  assert.deepEqual(await page.run('return window.cspViolations'), []);
  assert.deepEqual(page.reports.filter(report => report.channel === 'log' && report.source === 'security'), []);
  assert.deepEqual(page.errors, []);

});

test('Studio 浏览器 Markdown：真实 DOMParser 阻止脚本、事件、危险链接与外部资源', { timeout: 90000 }, async t => {
  assert.ok(chrome);
  const fixture = await studioWebFixture(t), page = await browser(t); await login(page, fixture);
  const result = await page.run(`const {markdown,outlineFromHtml}=await import('/app/markdown.mjs'); const div=document.createElement('div');
    div.append(markdown(${JSON.stringify('<script>window.injected=1</script><img src="https://example.com/x" onerror="window.injected=1"><a href="javascript:alert(1)" onclick="x()">危险</a>\n\n**正常**')}));
    document.body.append(div);
    const html=${JSON.stringify(read('wireframe-v1.html'))};
    for(let i=0;i<13;i++) outlineFromHtml(html);
    return {html:div.innerHTML,text:div.textContent,injected:window.injected||0,bad:div.querySelectorAll('script,img,[href^="javascript:"]').length,
      events:[...div.querySelectorAll('*')].flatMap(node=>[...node.attributes].filter(attr=>attr.name.startsWith('on'))).length};`);
  assert.equal(result.injected, 0); assert.equal(result.bad, 0); assert.equal(result.events, 0);
  assert.match(result.html, /<strong>正常<\/strong>/); assert.match(result.text, /<script>/);
  assert.deepEqual(await page.run('return window.cspViolations'), []);
  assert.deepEqual(page.reports.filter(report => report.channel === 'log' && report.source === 'security'), []);

});

test('Studio 产物示例：线框、主题样页、高保真所有屏幕与状态布局无错误', { timeout: 180000 }, async () => {
  assert.ok(chrome);
  for (const name of ['wireframe-v1.html', 'theme-sample-v1.html', 'theme-sample-v2.html', 'theme-sample-v3.html', 'prototype-v1.html', 'prototype-v2.html']) {
    const report = await checkDesign(path.resolve(import.meta.dirname, 'fixtures/studio', name));
    assert.equal(report.errors, 0, JSON.stringify(report));
    assert.equal(report.warnings, 0, JSON.stringify(report));
  }
});
