import test from 'node:test';
import assert from 'node:assert/strict';
import { rig, until } from './helpers.mjs';
import { PostgresJobs } from '../server/modules/data/jobs.mjs';

test('queue: 跨会话全局最多两轮；乱序唤醒仍按持久顺序排队；关闭保留 queued', async t => {
  const r = await rig(t);
  const sessions = [r.session, await r.sessions.create(), await r.sessions.create(), await r.sessions.create()];
  // Hold wakeups, enqueue in one order, wake in another.
  r.messages.queue = { close: async () => {} };
  for (let i = 0; i < 4; i++) await r.submit(`message ${i}`, `job${i}`, 'enqueue', null, sessions[i].id);
  r.messages.schedule(sessions[3].id);
  await until(() => r.messages.job('job1').status === 'running');
  assert.equal(r.messages.job('job2').status, 'queued');
  assert.equal(r.messages.job('job3').status, 'queued');
  assert.equal(r.rpc.calls.filter(c => c.method === 'turn/start').length, 2);
  r.rpc.finish(sessions[0].id);
  await until(() => r.messages.job('job0').status === 'completed');
  r.messages.schedule(sessions[3].id);
  await until(() => r.messages.job('job2').status === 'running');
  assert.equal(r.messages.job('job3').status, 'queued');
  r.messages.stopping = true;
  await r.messages.fail(new Error('shutdown'));
  // fail must still persist uncertain work after stopDispatch has set stopping.
  assert.equal(r.messages.job('job1').status, 'unconfirmed');
  assert.equal(r.messages.job('job2').status, 'unconfirmed');
  assert.equal(r.messages.job('job3').status, 'queued');
});
test('queue: 真实仓储的全局 200 与单会话 100 门禁使用事务锁，错误码 QUEUE_FULL', async () => {
  const calls = []; let n = 200, local = 0;
  const client = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [{ n, local }] }; } };
  const jobs = new PostgresJobs(client, { instanceId: 'instance', ownerId: 'owner' });
  await assert.rejects(jobs.queueCapacity(client, 'thread'), e => e.status === 429 && e.code === 'QUEUE_FULL');
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].args, ['instance']);
  n = 199; await jobs.queueCapacity(client, 'thread');
  n = 100; local = 100;
  await assert.rejects(jobs.queueCapacity(client, 'thread'), e => e.status === 429 && e.code === 'QUEUE_FULL');
  local = 99; await jobs.queueCapacity(client, 'thread');
});
test('queue: 工作流下一步满额时等待确认，不停止执行器', async t => {
  const r = await rig(t);
  const writes = [];
  r.messages.store.patch = async (id, fields) => {
    if (fields.status === 'queued') { const error = new Error('full'); error.code = 'QUEUE_FULL'; throw error; }
    writes.push({ id, ...fields }); return true;
  };
  await r.messages.patchOutcome({ id: 'flow', step: 0 }, { status: 'queued', step: 1 }, ['running']);
  assert.equal(writes[0].status, 'waiting'); assert.equal(writes[0].step, 0);
  assert.equal(r.messages.failure, null);
});

test('queue: 未发送任务回退不受新任务满额门禁影响，下一步/确认仍受门禁', async () => {
  let status = 'starting', checked = 0, wakes = 0;
  const client = { release() {}, async query(sql) {
    if (sql.startsWith('SELECT')) return { rows: [{ status, threadId: 'thread' }] };
    if (sql.startsWith('UPDATE')) return { rowCount: 1, rows: [{ thread_id: 'thread', status: 'queued' }] };
    if (sql.includes('INSERT INTO agent_data.outbox')) wakes++;
    return { rows: [] };
  } };
  const jobs = new PostgresJobs({ connect: async () => client }, { instanceId: 'test', ownerId: 'owner' });
  jobs.queueCapacity = async () => { checked++; throw Object.assign(new Error('full'), { code: 'QUEUE_FULL' }); };
  for (status of ['starting', 'steering', 'queued']) {
    assert.equal(await jobs.patch('task', { status: 'queued', error: null }, ['queued', 'starting', 'steering'], { restoreUnsent: true }), true);
  }
  assert.equal(checked, 0); assert.equal(wakes, 3);
  for (status of ['running', 'waiting', 'proposed'])
    await assert.rejects(jobs.patch('task', { status: 'queued' }, [status], { restoreUnsent: true }), e => e.code === 'QUEUE_FULL');
  status = 'starting';
  await assert.rejects(jobs.patch('task', { status: 'queued' }, ['starting']), e => e.code === 'QUEUE_FULL');
});
