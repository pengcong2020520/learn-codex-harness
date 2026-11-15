import test from 'node:test';
import assert from 'node:assert/strict';
import { expectStatus } from '../scripts/e2e-http.mjs';
import { createLogRedactor } from '../server/modules/config/index.mjs';

test('端到端 HTTP 诊断：成功保留响应体供后续读取', async () => {
  const response = new Response('检查内容', { status: 200 });
  assert.equal(await expectStatus(response, 200, '检查'), response);
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), '检查内容');
});

test('端到端 HTTP 诊断：失败包含状态、类型和前 300 字', async () => {
  const response = new Response('故'.repeat(301), { status: 503, headers: { 'content-type': 'text/html' } });
  await assert.rejects(expectStatus(response, 302, '根入口'), error => {
    assert.match(error.message, /根入口：期望 HTTP 302，实际 503；content-type：text\/html/);
    assert.equal(error.message.split('响应体前 300 字：')[1], '故'.repeat(300));
    return true;
  });
  await assert.rejects(expectStatus(new Response(null, { status: 503 }), 302, '空响应'), /content-type：未提供；响应体前 300 字：$/);
});

test('端到端 HTTP 诊断：JSON 凭据字段及正文和响应类型中的已知密钥脱敏', async () => {
  const secret = 'fixture-secret-not-real';
  const redact = createLogRedactor('', [secret]);
  const response = new Response(JSON.stringify({ token: 'fixture-issued-not-real', password: 'fixture-password-not-real', error: secret }), {
    status: 503, headers: { 'content-type': `text/plain; detail=${secret}` },
  });
  await assert.rejects(expectStatus(response, 200, '登录', redact), error => {
    assert.doesNotMatch(error.message, /fixture-/);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  // 已知密钥跨越第 300 字时，不能先截断再脱敏。
  await assert.rejects(expectStatus(new Response('前'.repeat(295) + secret, { status: 503 }), 200, '文本', redact), error => {
    assert.doesNotMatch(error.message, /fixt/);
    assert.equal(error.message.split('响应体前 300 字：')[1].length, 300);
    return true;
  });
});
