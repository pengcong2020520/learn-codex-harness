import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { browser, helpers } from './browser.mjs';

test('落地后从产品首页登录、打开产品对话、创建会话并收到完整回复', { timeout: 180000 }, async t => {
  const password = process.env.E2E_WEB_PASSWORD;
  assert.ok(password, '请在已落地的独立 Compose 项目运行。');
  const page = await browser(t);
  await page.open('http://127.0.0.1:' + (process.env.AGENT_PORT || 4317) + '/app/');
  // 产品首页先核对登录，跳转期间旧 document 会销毁。在宿主等待真实登录表单。
  let loginReady = false;
  for (let i = 0; i < 100 && !loginReady; i++) {
    loginReady = await page.run('return location.pathname === "/ui/" && !!document.querySelector("#username")').catch(() => false);
    if (!loginReady) await delay(100);
  }
  assert.ok(loginReady, '产品首页应跳转到登录表单');
  await page.run(helpers + `$('#username').value='admin';$('#password').value=${JSON.stringify(password)};`);
  await page.clickNavigate('#login-form button[type=submit]');
  assert.equal(await page.run(helpers + 'return await until(() => location.pathname === "/app/" && $("#open-chat"), 15000)'), true);
  await page.clickNavigate('#open-chat');
  assert.equal(await page.run(helpers + 'return await until(() => $("#new-session") && !$("#chat-view").hidden, 15000)'), true);
  await page.run('document.querySelector("#new-session").click()');
  assert.equal(await page.run(helpers + 'return await until(() => !$("#message").disabled, 30000)'), true);
  await page.run('document.querySelector("#message").value="请核对清单。";document.querySelector("#composer").requestSubmit();');
  assert.equal(await page.run(helpers + 'return await until(() => [...document.querySelectorAll(".message.assistant[data-status=completed]")].some(e => e.textContent.includes("已收到事项清单，可以继续整理。")), 90000)'), true);
});
