import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexConnection } from '../server/modules/codex/connection.mjs';
import { RuntimePool, busyError } from '../server/modules/runtimes/pool.mjs';
import { RuntimeRouter } from '../server/modules/runtimes/router.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { MessageService } from '../server/modules/messages/index.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { FakeRpc } from './helpers.mjs';
import { TestJobs } from './jobs-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function rig(t) {
  const owner = '22222222-2222-4222-8222-222222222222', native = new FakeRpc();
  const runtime = { workspaceDir: '/tmp' }, hub = { publish() {} };
  const pool = new RuntimePool({ create: async () => {
    const value = { rpc: native, runtime, close: async () => {} };
    rpc.attach(value, owner); return value;
  } });
  const rpc = new RuntimeRouter(pool, { isolated: true });
  const config = { root: '/tmp', launch: { timeoutMs: 60000 }, memory: {} };
  const sessions = new SessionService({ rpc, config, runtime, hub, redact: String });
  rpc.sessions = sessions;
  const gate = new PermissionGate({ scope: { ownerId: owner }, agent: { definition: { agent: { id: 'test' } } } });
  const store = new TestJobs(), messages = new MessageService({ rpc, sessions, config, hub, store, gate });
  const session = await rpc.withOwner(owner, () => sessions.create());
  store.create({ id: 'task', threadId: session.id, userId: owner, mode: 'enqueue', text: 'maintain' });
  t.after(async () => { await messages.close(); sessions.close(); await pool.close(); });
  const drain = async () => { runOwner('different-caller', () => messages.schedule(session.id)); await tick(); await messages.drain; };
  return { owner, native, pool, rpc, sessions, gate, store, messages, session, drain };
}

for (const phase of ['admission', 'closing-entry', 'ensure', 'beforeTurn', 'prepare', 'rpc-owner', 'closing-connection', 'native-before-send']) {
  test(`派发前 ${phase} 瞬时繁忙：queued、无 error、不暂停、10 秒后自动重试且重复唤醒不抢跑`, async t => {
    const r = await rig(t), { pool, rpc, messages, sessions, store, native, session, gate } = r;
    const error = phase === 'beforeTurn' ? Object.assign(new Error('restart'), { code: 'HUB_RESTART_PENDING' }) : busyError();
    let release;
    if (phase === 'admission') { pool.assertEnabled = async () => { throw error; }; release = () => { pool.assertEnabled = async () => {}; }; }
    if (phase === 'closing-entry') { const entry = pool.entries.get(r.owner); entry.state = 'closing'; release = () => { entry.state = 'ready'; }; }
    if (phase === 'ensure') {
      const value = sessions.sessions.get(session.id); sessions.sessions.delete(session.id);
      const ensure = sessions.ensure; sessions.ensure = async () => { throw error; };
      release = () => { sessions.ensure = ensure; sessions.sessions.set(session.id, value); };
    }
    if (phase === 'beforeTurn') {
      messages.permissionHub = { withUser: async (_, fn) => fn(), plan: async () => ({}) };
      sessions.beforeTurn = async () => { throw error; }; release = () => { sessions.beforeTurn = null; };
    }
    if (phase === 'prepare') {
      const prepare = sessions.prepareInput; sessions.prepareInput = async () => { throw error; };
      release = () => { sessions.prepareInput = prepare; };
    }
    if (phase === 'rpc-owner') { rpc.ownerOf = async () => { throw error; }; release = () => { rpc.ownerOf = null; }; }
    if (phase === 'closing-connection') { native.closing = true; release = () => { native.closing = false; }; }
    if (phase === 'native-before-send') { const request = native.request; native.request = async () => { throw error; }; release = () => { native.request = request; }; }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await r.drain();
    const job = store.get('task');
    assert.equal(job.status, 'queued'); assert.equal(job.error, null); assert.equal(job.turnId, null);
    assert.equal(store.paused(session.id), false); assert.equal(gate.runs.size, 0);
    assert.equal(native.calls.filter(c => c.method === 'turn/start').length, 0);
    assert.equal(messages.runtimeTimers.size, 1);
    release();
    await r.drain(); // Redis repeats a wakeup while the backoff is active.
    t.mock.timers.tick(9999); await tick(); await messages.drain;
    assert.equal(job.status, 'queued');
    t.mock.timers.tick(1); await tick(); await messages.drain;
    assert.equal(job.status, 'running', JSON.stringify(job)); assert.equal(job.error, null);
    assert.equal(messages.runtimeTimers.size, 0);
    assert.equal(native.calls.filter(c => c.method === 'turn/start').length, 1);
  });
}

test('turn/start 已交给用户 RPC 后繁忙/断连仍为 unconfirmed，不得自动重发', async t => {
  const r = await rig(t), request = r.native.request.bind(r.native);
  r.native.request = async (method, params, options) => {
    if (method === 'turn/start') { await request(method, params, options); throw busyError(); }
    return request(method, params, options);
  };
  await r.drain();
  assert.equal(r.store.get('task').status, 'unconfirmed');
  assert.equal(r.store.paused(r.session.id), true);
  assert.equal(r.messages.runtimeTimers.size, 0);
  await r.drain();
  assert.equal(r.native.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('受控重启：关闭旧进程后 single-flight 启动就绪才派发', async t => {
  const r = await rig(t);
  let finishClose, finishStart, starts = 0, closed = false, ready = false;
  const old = r.pool.entries.get(r.owner).value;
  old.close = () => new Promise(resolve => { finishClose = () => { closed = true; resolve(); }; });
  r.pool.shouldRestart = async (_, value) => value === old;
  r.pool.create = async () => {
    starts++; assert.equal(closed, true);
    await new Promise(resolve => { finishStart = resolve; }); ready = true;
    return { rpc: r.native, runtime: old.runtime, close: async () => {} };
  };
  const request = r.native.request.bind(r.native);
  r.native.request = (method, params, options) => { if (method === 'turn/start') assert.equal(ready, true); return request(method, params, options); };
  const draining = r.drain(); await tick();
  const concurrent = r.rpc.withOwner(r.owner, () => {});
  assert.equal(r.store.get('task').status, 'queued'); assert.equal(starts, 0);
  finishClose(); await tick();
  assert.equal(starts, 1); assert.equal(r.store.get('task').status, 'queued');
  finishStart(); await Promise.all([draining, concurrent]);
  assert.equal(starts, 1); assert.equal(r.store.get('task').status, 'running');
});

test('Retry-After 自定义秒数生效；关闭服务清理延迟唤醒', async t => {
  const r = await rig(t);
  r.pool.assertEnabled = async () => { throw Object.assign(busyError(), { retryAfter: 12 }); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await r.drain(); r.pool.assertEnabled = async () => {};
  t.mock.timers.tick(10000); await tick(); assert.equal(r.store.get('task').status, 'queued');
  await r.messages.close(); assert.equal(r.messages.runtimeTimers.size, 0);
  t.mock.timers.tick(2000); await tick(); assert.equal(r.store.get('task').status, 'queued');
});

test('Retry-After 12 秒：满 12 秒才自动重新派发', async t => {
  const r = await rig(t);
  r.pool.assertEnabled = async () => { throw Object.assign(busyError(), { retryAfter: 12 }); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await r.drain(); r.pool.assertEnabled = async () => {};
  t.mock.timers.tick(11999); await tick(); assert.equal(r.store.get('task').status, 'queued');
  t.mock.timers.tick(1); await tick(); await r.messages.drain;
  assert.equal(r.store.get('task').status, 'running');
});

test('追加在用户 RPC 前繁忙可重试，保留原任务的权限上下文', async t => {
  const r = await rig(t);
  const original = { id: 'original', userId: r.owner, threadId: r.session.id };
  r.gate.start(original);
  const result = await r.rpc.withOwner(r.owner, () => r.rpc.request('turn/start', { threadId: r.session.id, input: [] }));
  r.gate.started(r.session.id, result.turn.id);
  const context = r.gate.forTurn(r.session.id, result.turn.id);
  Object.assign(r.store.get('task'), { mode: 'append', targetTurnId: result.turn.id });
  r.rpc.ownerOf = async () => { throw busyError(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await r.drain();
  assert.equal(r.store.get('task').status, 'queued'); assert.equal(r.store.get('task').error, null);
  assert.equal(r.store.paused(r.session.id), false);
  assert.strictEqual(r.gate.forTurn(r.session.id, result.turn.id), context);
  assert.equal(r.native.calls.filter(c => c.method === 'turn/steer').length, 0);
  r.rpc.ownerOf = null;
  t.mock.timers.tick(10000); await tick(); await r.messages.drain;
  assert.equal(r.store.get('task').status, 'running');
  assert.equal(r.native.calls.filter(c => c.method === 'turn/steer').length, 1);
  assert.strictEqual(r.gate.forTurn(r.session.id, result.turn.id), context);
});

test('原生传输边界：只有 stdin.write 成功后才调用 onSent，发送前拒绝不会标记', async () => {
  for (const reject of [false, true]) {
    let sent = false, request;
    const rpc = new CodexConnection({ launch: { timeoutMs: 1000 }, runtime: {}, redact: String });
    rpc.record = () => {};
    rpc.child = { stdin: { write(text) {
      assert.equal(sent, false);
      if (reject) throw new Error('write rejected before send');
      request = JSON.parse(text);
    } } };
    const result = rpc.request('turn/start', { threadId: 'thread' }, { onSent: () => { sent = true; } });
    assert.equal(sent, !reject);
    if (reject) await assert.rejects(result, /write rejected/);
    else { rpc.receive({ id: request.id, result: { turn: { id: 'turn' } } }); assert.equal((await result).turn.id, 'turn'); }
    assert.equal(rpc.pending.size, 0);
  }
});
