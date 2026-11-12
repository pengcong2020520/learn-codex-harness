import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageService } from '../server/modules/messages/index.mjs';
import { TestJobs } from './jobs-fixture.mjs';

test('撤权在 queued 阶段拒绝：必须写入 failed，不能只暂停会话留下 queued', async () => {
  const store = new TestJobs({ jobs: [{ id: 'after-revoke', threadId: 'carol-thread', status: 'queued', turnId: null }], paused: [] });
  const service = { store, runtimeBusy: () => false };
  await MessageService.prototype.executionError.call(service, store.get('after-revoke'), Object.assign(new Error('资源不存在。'), { code: 'HUB_DENIED' }), false);
  assert.equal(store.get('after-revoke').status, 'failed');
  assert.equal(store.get('after-revoke').turnId, null);
  assert.equal(store.paused('carol-thread'), true);
});

import { Pool, Client } from 'pg';
import { businessQuery, fencePool } from '../server/modules/data/write.mjs';
import { PostgresJobs } from '../server/modules/data/jobs.mjs';
import { transaction } from '../server/modules/data/database.mjs';

function databaseDouble() {
  const calls = [];
  let term, active = false;
  const raw = { release() {}, connect: async () => raw, query: async sql => {
    calls.push(sql);
    if (sql === 'BEGIN') { active = true; term = null; }
    if (sql.startsWith('SET LOCAL app.term')) term = sql.match(/'(.+)'/)[1];
    if (/\b(UPDATE|INSERT|DELETE)\b/.test(sql) && (!active || term !== '42')) throw Object.assign(new Error('missing term'), { code: 'CT001' });
    if (/^(COMMIT|ROLLBACK)$/.test(sql)) { active = false; term = null; }
    return { rowCount: 1, rows: [{ thread_id: 'thread', status: 'failed' }] };
  } };
  return { raw, calls };
}

test('统一业务入口拒绝未包装的真实 pg Pool/Client，发送 SQL 前暴露编程错误', async () => {
  const pool = new Pool(), client = new Client();
  for (const connection of [pool, client]) {
    connection.query = () => assert.fail('must reject before sending');
    assert.throws(() => businessQuery(connection, 'UPDATE agent_data.tasks SET status=\'failed\''), { code: 'TERM_REQUIRED' });
  }
  await pool.end();
});

test('缺失/非法任期与已经失效的本地 control 在 checkout 前失败，不隔离为 CT001', () => {
  for (const term of [undefined, null, '', '0', '-1', 'invalid']) {
    const pool = fencePool({ connect: () => assert.fail('no checkout') }, { term, assert() {}, isolate: () => assert.fail('programming error') });
    assert.throws(() => pool.query('UPDATE agent_data.tasks SET error=NULL'), { code: 'TERM_REQUIRED' });
  }
  const pool = fencePool({ connect: () => assert.fail('no checkout') }, { term: '42', assert() { throw Object.assign(new Error('lost'), { code: 'NOT_CONTROLLER' }); } });
  assert.throws(() => pool.query('SELECT 1'), { code: 'NOT_CONTROLLER' });
});

test('任务 failed 更新及通知插入共用带任期事务；连接重用不泄漏 LOCAL term', async () => {
  const { raw, calls } = databaseDouble();
  const pool = fencePool(raw, { term: '42', assert() {} });
  const jobs = new PostgresJobs(pool, { instanceId: 'instance', ownerId: 'carol' });
  assert.equal(await jobs.patch('after-revoke', { status: 'failed', error: '资源不存在。' }, ['queued']), true);
  assert.match(calls[1], /SET LOCAL app.term = '42'/);
  assert.match(calls[2], /UPDATE agent_data.tasks/);
  assert.match(calls[3], /INSERT INTO agent_data.notifications/);
  assert.equal(calls[4], 'COMMIT');
  await businessQuery(pool, 'DELETE FROM agent_data.outbox WHERE false');
  await assert.rejects(raw.query('DELETE FROM agent_data.outbox WHERE false'), { code: 'CT001' });
  assert.equal(calls.filter(sql => sql.startsWith('SET LOCAL')).length, 2);
});

test('CT001 记录发送位置、当前任期与调用栈；仍认为是 control 时先记录再隔离', async () => {
  const order = [];
  const raw = { connect: async () => raw, release() {}, query: async sql => {
    if (sql.startsWith('UPDATE')) throw Object.assign(new Error('missing or stale cluster term'), { code: 'CT001' });
  } };
  const pool = fencePool(raw, { term: '42', assert() {}, log: message => order.push(message), isolate: () => order.push('isolated') });
  async function failedTaskWrite() { return businessQuery(pool, 'UPDATE agent_data.tasks SET status=\'failed\''); }
  await assert.rejects(failedTaskWrite(), error => {
    assert.equal(error.code, 'CT001');
    assert.equal(error.termDiagnostic.diagnostic, '任期过期或漏传任期');
    assert.match(error.termDiagnostic.stack, /failedTaskWrite/);
    return true;
  });
  assert.equal(order.length, 2);
  const diagnostic = JSON.parse(order[0].slice('[CT001] '.length));
  assert.equal(diagnostic.sqlstate, 'CT001'); assert.equal(diagnostic.term, '42');
  assert.equal(diagnostic.operation, 'UPDATE'); assert.equal(diagnostic.table, 'tasks');
  assert.equal(diagnostic.diagnostic, '任期过期或漏传任期');
  assert.equal(order[1], 'isolated');
});

test('显式事务的 CT001 也记录调用栈；本地已知过期与漏传任期分开诊断', async () => {
  let current = true, diagnostic;
  const raw = { connect: async () => raw, release() {}, query: async sql => {
    if (sql.startsWith('UPDATE')) { current = false; throw Object.assign(new Error('stale'), { code: 'CT001' }); }
  } };
  const pool = fencePool(raw, { term: '42', assert() { if (!current) throw new Error('lost'); }, log: value => { diagnostic = value; }, isolate() {} });
  await assert.rejects(transaction(pool, client => businessQuery(client, 'UPDATE agent_data.tasks SET error=NULL')), { code: 'CT001' });
  assert.match(diagnostic, /任期已失效/);
  assert.match(diagnostic, /coordination-write.test.mjs/);
});

import { hubFixture } from './hub-fixture.mjs';
import { rig } from './helpers.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';

test('Bob 撤权 → Carol 下一轮真实 prepareInput 门禁 → failed；不调用 turn/start', async t => {
  const r = await rig(t), { hub, as, agent } = hubFixture();
  r.messages.queue = { close: async () => {} };
  await as('bob', () => hub.grantKnowledge('general', 'carol'));
  const row = { hub_knowledge: ['general'] };
  const inputService = {
    permissionHub: hub, config: { agent: { definition: { agent }, input: text => [text] } },
    assertCompatible: async () => {}, beforeTurn: async () => {}, repository: { conversation: async () => row },
  };
  await as('carol', () => SessionService.prototype.prepareInput.call(inputService, r.session.id, 'before revoke', 'hash'));
  await r.submit('再次读取共享知识库', 'after-revoke');
  const job = r.messages.job('after-revoke'); job.userId = 'carol';
  r.sessions.sessions.get(r.session.id).ownerId = 'carol';
  r.messages.permissionHub = hub;
  r.sessions.prepareInput = (...args) => SessionService.prototype.prepareInput.call(inputService, ...args);
  await as('bob', () => hub.revoke('knowledge', 'general', 'carol'));
  const requestsBefore = r.rpc.calls.length;
  await as('carol', () => r.messages.dispatch(r.session.id));
  assert.equal(job.status, 'failed');
  assert.match(job.error, /资源不存在|未授权/);
  assert.equal(job.turnId, null);
  assert.equal(r.rpc.calls.length, requestsBefore);
});

test('SET LOCAL 等待期间丢失任期：业务语句不发送，事务回滚', async () => {
  let active = true;
  const calls = [];
  const raw = { connect: async () => raw, release() {}, query: async sql => {
    calls.push(sql); if (sql.startsWith('SET LOCAL')) active = false;
  } };
  const pool = fencePool(raw, { term: '42', assert() { if (!active) throw Object.assign(new Error('lost'), { code: 'NOT_CONTROLLER' }); } });
  await assert.rejects(businessQuery(pool, 'UPDATE agent_data.tasks SET error=NULL'), { code: 'NOT_CONTROLLER' });
  assert.deepEqual(calls, ['BEGIN', "SET LOCAL app.term = '42'", 'ROLLBACK']);
});

test('未发送任务的错误回调也不能覆盖已收敛结果', async () => {
  for (const status of ['unconfirmed', 'completed', 'failed', 'cancelled', 'interrupted', 'needs-review']) {
    const store = new TestJobs({ jobs: [{ id: 'job', threadId: 'thread', status }], paused: [] });
    await MessageService.prototype.executionError.call({ store, runtimeBusy: () => false }, store.get('job'), new Error('late callback'), false);
    assert.equal(store.get('job').status, status);
  }
});

import { trackDispatch } from '../server/modules/coordination/fence.mjs';
test('关停补记复用正常任期入口：失去任期后不能通过空 assert 写回', async () => {
  let active = true;
  const { raw, calls } = databaseDouble();
  const pool = fencePool(raw, { term: '42', assert() { if (!active) throw Object.assign(new Error('lost'), { code: 'NOT_CONTROLLER' }); } });
  const jobs = { patch: async () => true };
  const recover = trackDispatch(jobs, pool, 'instance');
  await jobs.patch('job', { status: 'running' });
  active = false;
  await assert.rejects(recover(), { code: 'NOT_CONTROLLER' });
  assert.deepEqual(calls, []);
});

test('连接池已满时取连接超时 → 503 DATABASE_BUSY、不自我隔离；未满时同样的超时仍按断连隔离', async () => {
  const timeout = () => Promise.reject(new Error('timeout exceeded when trying to connect'));
  const isolated = [];
  const generation = { term: '42', assert() {}, log() {}, isolate: reason => isolated.push(reason) };
  const busy = fencePool({ totalCount: 6, options: { max: 6 }, on() {}, connect: timeout }, generation);
  await assert.rejects(busy.query('SELECT 1'), error => error.status === 503 && error.code === 'DATABASE_BUSY');
  assert.deepEqual(isolated, []);
  const lost = fencePool({ totalCount: 0, options: { max: 6 }, on() {}, connect: timeout }, generation);
  await assert.rejects(lost.query('SELECT 1'), /timeout exceeded/);
  assert.deepEqual(isolated, ['database-connection-lost:timeout exceeded when trying to connect']);
});
