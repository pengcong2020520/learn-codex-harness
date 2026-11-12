// External server acceptance; does not write client credentials or call a model.
import assert from 'node:assert/strict';
import { createPrompts } from '../shared/prompts.mjs';
import { loadServerAddress } from '../client/modules/connection/index.mjs';

if (process.argv.length !== 2) throw new Error('不接受参数；用户名和密码只能交互输入。');
const prompts = createPrompts();
const url = loadServerAddress();
const call = async (route, token, body) => {
  const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
};
const login = async label => {
  const username = await prompts.ask(`${label} 用户名：`), password = await prompts.ask(`${label} 密码：`, { secret: true });
  const result = await call('/auth/login', null, { username, password });
  assert.equal(result.status, 200, `${label} 登录失败`);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  return result.body;
};
let a, b;
try {
  a = await login('A'); b = await login('B');
  assert.notEqual(a.user.id, b.user.id, '必须使用两个不同账号');
  const created = await call('/sessions', a.token, {}); assert.equal(created.status, 201);
  const threadId = created.body.id;
  const listed = await call('/sessions', b.token); assert.equal(listed.status, 200);
  assert.ok(!listed.body.sessions.some(item => item.id === threadId));
  const foreign = await call('/sessions/resume', b.token, { threadId });
  assert.equal(foreign.status, 404); assert.equal(foreign.body.error.code, 'NOT_FOUND');
  const ka = await call('/knowledge', a.token), kb = await call('/knowledge', b.token);
  assert.equal(ka.status, 200); assert.equal(kb.status, 200);
  assert.ok(ka.body.knowledge.length, 'A 必须拥有至少一个知识库才能验收知识库隔离');
  for (const item of ka.body.knowledge) {
    assert.ok(!kb.body.knowledge.some(other => other.kbId === item.kbId));
    const result = await call(`/knowledge/pages?kbId=${encodeURIComponent(item.kbId)}`, b.token);
    assert.equal(result.status, 404); assert.equal(result.body.error.code, 'NOT_FOUND');
  }
  assert.equal((await call('/auth/logout', a.token, {})).status, 200);
  assert.equal((await call('/auth/me', a.token)).status, 401);
  assert.equal((await call('/auth/me', b.token)).status, 200);
  // 使用不存在的测试账号，验证失败窗口；不会锁住实际 A/B 用户名。
  for (let i = 0; i < 5; i++) assert.equal((await call('/auth/login', null, { username: 'acceptance-missing-account', password: 'wrong-fixture-password' })).status, 401);
  const limited = await call('/auth/login', null, { username: 'acceptance-missing-account', password: 'wrong-fixture-password' });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  console.log('PASS：两个账号会话与知识库隔离，跨用户 404 NOT_FOUND，登出后 401，登录限流 429 + Retry-After。');
} catch {
  console.error('FAIL：服务器认证验收未通过；检查服务配置、账号和登录限流窗口。未输出密码或令牌。'); process.exitCode = 1;
} finally {
  for (const login of [a, b]) if (login) await call('/auth/logout', login.token, {}).catch(() => {});
  prompts.close();
}
