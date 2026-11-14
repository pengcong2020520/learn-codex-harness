import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, sseState } from '../web/modules/sse.mjs';
import { apiError, createApi } from '../web/modules/api.mjs';
import { reduceEvent, emptyState, messagesView, hasLoss, pauseReason, statusLabel } from '../web/modules/view-model.mjs';
import { applySessionEvent as canonical } from '../shared/session-events.mjs';
import { applySessionEvent } from '../web/modules/session-events.mjs';

test('网页 SSE：任意分块、CRLF、注释、多行 data、id 持续与重置、不完整帧不派发', () => {
  const text = '\uFEFF: hello\r\nid: node:3\r\ndata: {"a":\r\ndata: 1}\r\n\r\n: heartbeat\n\ndata: next\n\nid:\n\ndata:last\n\nid: bad\0id\n\ndata: unfinished';
  for (let size = 1; size <= text.length; size++) {
    let state = sseState(), frames = [];
    for (let n = 0; n < text.length; n += size) { const parsed = parseSse(state, text.slice(n, n + size)); frames.push(...parsed.events); state = parsed.state; }
    assert.deepEqual(frames, [{ data: '{"a":\n1}', id: 'node:3', event: 'message' }, { data: 'next', id: 'node:3', event: 'message' }, { data: 'last', id: '', event: 'message' }]);
    assert.equal(state.lastEventId, '');
  }
  const original = sseState('resume:1');
  assert.equal(parseSse(original, 'data: replay\n\n').events[0].id, 'resume:1');
  assert.deepEqual(original, sseState('resume:1'), 'parser does not mutate caller state');
  assert.equal(parseSse(sseState(), 'event: turn\ndata:\n\n').events[0].event, 'turn');
  assert.throws(() => parseSse(sseState(), 'x'.repeat(4 * 1024 * 1024 + 1)), /过大/);
});
test('网页接口错误：401/403/429/503、错误密码、Retry-After 秒数与日期', () => {
  assert.match(apiError(401).message, /重新登录/);
  assert.equal(apiError(401, { error: { code: 'LOGIN_FAILED', message: '用户名或密码错误。' } }).message, '用户名或密码错误。');
  assert.match(apiError(403).message, /权限/);
  assert.match(apiError(403, { error: { message: '不允许的来源。' } }).message, /来源/);
  assert.match(apiError(429, {}, '12').message, /请求过于频繁.*12 秒/);
  assert.match(apiError(503, { error: { message: '节点繁忙' } }, '8').message, /服务暂时不可用.*节点繁忙.*8 秒/);
  assert.equal(apiError(503, {}, 'Thu, 01 Jan 1970 00:00:10 GMT', 2000).retryAfter, 8);
  assert.equal(apiError(503, {}, 'bad').retryAfter, null);
  assert.equal(apiError(503).retryAfter, null);
});
test('网页请求：Bearer、无 cookie；任何 401（包括非 JSON）均注销', async () => {
  let loggedOut = 0, sent;
  const api = createApi({ getToken: () => 'secret', onUnauthorized: () => loggedOut++, fetcher: async (route, options) => { sent = options; return new Response('not json', { status: 401 }); } });
  await assert.rejects(api.request('/auth/me'), { status: 401 });
  assert.equal(loggedOut, 1); assert.equal(sent.headers.Authorization, 'Bearer secret'); assert.equal(sent.credentials, 'omit');
});
test('网页重连：1 秒后重建 SSE，先快照、无旧 Last-Event-ID；关闭取消；401 停止', async () => {
  let calls = 0, unauthorized = 0; const statuses = [], events = [], times = [];
  const api = createApi({ getToken: () => 'test', onUnauthorized: () => unauthorized++, fetcher: async (route, options) => {
    calls++; times.push(Date.now()); assert.equal(options.headers.Authorization, 'Bearer test'); assert.equal(options.headers['last-event-id'], undefined);
    if (calls === 2) return new Response('{}', { status: 401 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('id: primary:1\ndata: {"type":"snapshot","data":{}}\n\n')); controller.close(); } }));
  } });
  const sub = api.subscribe('thread', event => events.push(event), status => statuses.push(status)); await sub.done;
  assert.equal(calls, 2); assert.ok(times[1] - times[0] >= 950); assert.equal(unauthorized, 1);
  assert.deepEqual(statuses, ['connected', 'reconnecting']); assert.equal(events[0].type, 'snapshot');
  const stopped = createApi({ getToken: () => 'test', onUnauthorized() {}, fetcher: async () => { throw Error('offline'); } }).subscribe('t', () => {}, () => {});
  stopped.close(); await stopped.done;
});
test('网页视图：快照、增量去重、缺口重同步、任务状态、确认点、失败原因与副本缺失', () => {
  const session = { id: 't', model: 'server-model', turns: [{ id: 'turn', status: 'inProgress', messages: [{ id: 'u', clientId: 'task', text: '问题' }], answers: {} }] };
  let state = reduceEvent(emptyState(), { type: 'snapshot', data: { session, queue: { jobs: [{ id: 'task', text: '问题', turnId: 'turn', status: 'running' }] } } });
  const delta = { type: 'delta', threadId: 't', data: { turnId: 'turn', itemId: 'answer', offset: 0, text: '流式' } };
  assert.deepEqual(applySessionEvent(session, delta), canonical(session, delta));
  state = reduceEvent(state, delta); state = reduceEvent(state, delta);
  assert.equal(messagesView(state)[1].text, '流式'); assert.equal(messagesView(state)[0].label, '执行中');
  assert.equal(reduceEvent(state, { ...delta, data: { ...delta.data, offset: 100 } }), null);
  for (const status of ['queued', 'starting', 'steering', 'running', 'completed', 'failed', 'waiting', 'proposed', 'needs-review', 'unconfirmed', 'replica_missing', 'cancelled']) {
    const next = reduceEvent(state, { type: 'queue', threadId: 't', data: { jobs: [{ id: 'task', text: '问题', turnId: 'turn', status, error: '服务端原因', selectedModel: 'actual-model' }] } });
    const row = messagesView(next)[0]; assert.equal(row.label, statusLabel(status)); assert.equal(row.confirm, ['waiting', 'proposed'].includes(status)); assert.equal(row.error, '服务端原因'); assert.equal(row.model, 'actual-model');
    assert.equal(messagesView(next).filter(row => row.role === 'user').length, 1);
  }
  assert.equal(hasLoss({ replicaMissing: true }), true); assert.equal(hasLoss({ replica_missing: true }), true); assert.equal(hasLoss({ missingTurns: ['turn'] }), true);
  assert.equal(pauseReason({ jobs: [{ status: 'failed', error: '暂停原因' }] }), '暂停原因');
});
test('网页缺口恢复：resync 立即中止旧流并重新获取快照，关闭后不再重连', async () => {
  let calls = 0, subscription; const events = [], statuses = [];
  const api = createApi({ getToken: () => 'test', onUnauthorized() {}, fetcher: async (route, options) => {
    const type = ++calls === 1 ? 'delta' : 'snapshot';
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type })}\n\n`));
    } }));
  } });
  subscription = api.subscribe('t', event => {
    events.push(event.type);
    if (event.type === 'delta') subscription.resync();
    else subscription.close();
  }, status => statuses.push(status));
  await subscription.done;
  assert.deepEqual(events, ['delta', 'snapshot']); assert.equal(calls, 2);
  assert.deepEqual(statuses, [], '被主动中止的旧流不得触发 connected 或自动重试提示');
});


test('网页确认点：waiting 显示三个动作及重做次数，提议不提供修改，重新排队收起动作', () => {
  const state = { session: { id: 't', turns: [] }, queue: { jobs: [{ id: 'w', text: '任务', status: 'waiting', reviseCount: 3 }] } };
  const row = messagesView(state)[0];
  assert.deepEqual(row.actions, ['继续', '修改', '结束']);
  assert.equal(row.reviseCount, 3);
  const next = reduceEvent(state, { type: 'queue', threadId: 't', data: { jobs: [{ ...row.job, status: 'queued', reviseCount: 4 }] } });
  assert.deepEqual(messagesView(next)[0].actions, []);
  assert.equal(messagesView(next)[0].reviseCount, 4);
  assert.deepEqual(messagesView({ ...state, queue: { jobs: [{ ...row.job, status: 'proposed' }] } })[0].actions, ['继续', '结束']);
});


test('网页重做多轮：相同 clientId 只显示一组确认动作', () => {
  const job = { id: 'task', text: '原始任务', status: 'waiting', turnId: 'turn-2', reviseCount: 1 };
  const session = { id: 't', turns: [1, 2].map(n => ({ id: `turn-${n}`, status: 'completed', messages: [{ id: `message-${n}`, clientId: 'task', text: n === 1 ? '原始任务' : '重做意见' }] })) };
  const rows = messagesView({ session, queue: { jobs: [job] } });
  assert.equal(rows.filter(row => row.confirm).length, 1);
  assert.equal(rows.find(row => row.confirm).reviseCount, 1);
  assert.ok(rows.some(row => row.text === '重做意见'));
});
