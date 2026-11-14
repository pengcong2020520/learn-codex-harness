// Invoked while e2e-compose.sh's isolated stack is still running, before its cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, chrome, helpers } from './browser.mjs';

test('Docker 网页端到端：Caddy 跳转、管理员登录、发送、失败终态与原因', { timeout: 240000 }, async t => {
  assert.ok(chrome, 'CI 必须安装 Chrome。');
  const password = process.env.E2E_WEB_PASSWORD;
  assert.ok(password, '需由 e2e-compose.sh 提供临时管理员密码。');
  const url = `http://127.0.0.1:${process.env.AGENT_PORT || 4317}`;
  assert.equal((await fetch(url + '/', { redirect: 'manual' })).status, 302);
  const ui = await fetch(url + '/ui/');
  assert.equal(ui.status, 200);
  assert.equal(ui.headers.get('content-security-policy'), "default-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  assert.equal(ui.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ui.headers.get('referrer-policy'), 'no-referrer');
  const page = await browser(t);
  await page.open(url + '/');
  assert.equal(await page.run('return location.pathname'), '/ui/');
  await page.run(`document.querySelector('#username').value='admin';document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#chat-view').hidden && $('#agent-name').textContent !== 'Agent', 15000);`), true);
  await page.run(`document.querySelector('#new-session').click();`);
  assert.equal(await page.run(`${helpers} return await until(() => !$('#message').disabled, 30000);`), true);
  await page.run(`document.querySelector('#message').value='请回复一行文字。';document.querySelector('#composer').requestSubmit();`);
  assert.equal(await page.run(`${helpers} return await until(() => $('.message[data-status="failed"] .error')?.textContent.trim(), 180000);`), true, '占位密钥应产生失败终态，并展示服务端失败原因');
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.networkErrors, []);
});
