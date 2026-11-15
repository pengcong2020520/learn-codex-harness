import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { runIdentity } from '../server/modules/accounts/context.mjs';
import { accountFixture, httpFixture, request, Response, OWNER_A } from './accounts-fixture.mjs';
import { studioRig } from './studio-fixture.mjs';
import { TEST_IMAGE } from '../scripts/gateway-check.mjs';
const admin = work => runIdentity({ userId: OWNER_A, role: 'admin' }, work);

// 无监听端口的真实 HTTP handler 回归：确认浏览器夹具的权限、图片能力和调用形状与服务端一致。
test('Studio UI HTTP 契约：空项目入口、草稿、两张图、design、固定澄清反馈及恢复', async t => {
  const r = await admin(() => studioRig(t, { initialDrafts: false, vision: true }));
  const { accounts } = await accountFixture();
  r.config.previewSecret = randomBytes(32).toString('hex');
  const http = httpFixture(accounts, { config: r.config, sessions: r.sessions, messages: r.messages, files: r.files,
    gate: r.gate, permissionHub: r.permissionHub, hub: r.hub,
    tools: { snapshot: () => ({ tools: r.agent.definition.agent.tools.allow.map(name => ({ name })) }) } });
  t.after(() => http.close());
  const token = (await accounts.login({ username: 'alice', password: 'fixture-password' }, 'fixture')).token;
  const get = url => request(http, url, { token });
  const post = (url, body) => request(http, url, { token, body });
  assert.equal((await get('/workbench')).body.imageInput, true);
  assert.equal((await get('/workbench')).body.viewer.admin, true);
  const drafts = await get('/workspace?path=inputs/drafts');
  assert.equal(drafts.statusCode, 200); assert.deepEqual(drafts.body.entries, []);
  assert.equal((await get('/sessions')).statusCode, 200);
  for (const [name, value] of [['project.json', { id: 'task-helper', name: '事项助手' }], ['brief.json', { fields: { name: { value: '事项助手', source: 'user', evidence: '事项助手' } } }]]) {
    assert.equal((await request(http, `/workspace/drafts?name=${name}`, { token, method: 'PUT', body: value })).statusCode, 200);
  }
  const missing = await get('/workspace/drafts?name=missing.json');
  assert.equal(missing.statusCode, 404); assert.equal(missing.body.error.message, '草稿不存在。');
  const attachments = ['inputs/uploads/参考一.png', 'inputs/uploads/参考二.png'];
  for (const locator of attachments) {
    const req = Readable.from([Buffer.from(TEST_IMAGE.split(',')[1], 'base64')]);
    Object.assign(req, { method: 'PUT', url: `/workspace/files?path=${encodeURIComponent(locator)}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' }, socket: { remoteAddress: 'fixture' } });
    const res = new Response(); await http.handle(req, res); assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  }
  const session = await post('/sessions', {}); assert.equal(session.statusCode, 201);
  const threadId = session.body.id;
  const submission = await post('/messages', { threadId, clientMessageId: 'ui-design', text: '按资料卡设计', workflow: 'design', attachments });
  assert.equal(submission.statusCode, 202, JSON.stringify(submission.body));
  const started = await r.started(1); assert.equal(started.filter(item => item.type === 'image').length, 2);
  assert.equal((await post('/sessions/resume', { threadId })).statusCode, 200);
  assert.equal((await get(`/state?threadId=${threadId}`)).body.queue.jobs[0].id, 'ui-design');
  await admin(() => r.permissionHub.withUser(OWNER_A, () => r.produce(['clarify-r1.json'], 0)));
  assert.equal((await request(http, '/workspace/drafts?name=clarify.json', { token, method: 'PUT', body: { round: 1, answers: [{ id: 'q1', text: '我确认后保存' }] } })).statusCode, 200);
  const feedback = await post('/tasks/feedback', { taskId: 'ui-design', text: '提交第 1 轮澄清答案', attachments: [] });
  assert.deepEqual(feedback.body, { mode: 'revise' }); await r.started(2);
  assert.match(r.rpc.calls.filter(call => call.method === 'turn/start').at(-1).params.input.map(item => item.text || '').join('\n'), /提交第 1 轮澄清答案/);
});
