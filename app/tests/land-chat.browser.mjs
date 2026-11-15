import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { browser, helpers } from './browser.mjs';

// 跨文档跳转时短暂销毁 JS 上下文；等待在浏览器外进行，每次点击只发送一次。
async function waitPage(page, condition, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { if (await page.run('return document.readyState === "complete" && (' + condition + ')')) return; }
    catch (error) { if (!/context|navigated/i.test(error.message)) throw error; }
    await delay(100);
  }
  assert.fail(message);
}

async function clickLinkOrButton(page, selector) {
  const [x, y] = await page.run('const el = document.querySelector(' + JSON.stringify(selector) + '); el.scrollIntoView(); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];');
  await page.clickAt(x, y);
}

test('落地后从产品首页登录、打开产品对话、创建会话并收到完整回复', { timeout: 180000 }, async t => {
  const password = process.env.E2E_WEB_PASSWORD;
  assert.ok(password, '请在已落地的独立 Compose 项目运行。');
  const page = await browser(t);
  await page.open('http://127.0.0.1:' + (process.env.AGENT_PORT || 4317) + '/app/');
  await waitPage(page, 'location.pathname === "/ui/" && !!document.querySelector("#username")', '产品首页应跳转到登录表单');
  await page.run(helpers + `$('#username').value='admin';$('#password').value=${JSON.stringify(password)};`);
  await clickLinkOrButton(page, '#login-form button[type=submit]');
  await waitPage(page, 'location.pathname === "/app/" && !!document.querySelector("#open-chat")', '登录后应返回产品首页');
  await clickLinkOrButton(page, '#open-chat');
  await waitPage(page, 'location.pathname === "/ui/" && document.querySelector("#chat-view")?.hidden === false', '打开对话后应看到已登录的会话页面');
  await page.run('document.querySelector("#new-session").click()');
  assert.equal(await page.run(helpers + 'return await until(() => !$("#message").disabled, 30000)'), true);
  await page.run('document.querySelector("#message").value="请核对清单。";document.querySelector("#composer").requestSubmit();');
  assert.equal(await page.run(helpers + 'return await until(() => [...document.querySelectorAll(".message.assistant[data-status=completed]")].some(e => e.textContent.includes("已收到事项清单，可以继续整理。")), 90000)'), true);
  assert.equal(await page.run(helpers + 'return await until(() => $("#artifact-list").children.length || $("#artifact-status").textContent === "暂无文件。", 10000)'), true);
  const workspaceErrors = page.reports.filter(report => report.source === 'network' && report.level === 'error' && report.url && new URL(report.url).pathname === '/workspace');
  assert.deepEqual(workspaceErrors, []);
});
