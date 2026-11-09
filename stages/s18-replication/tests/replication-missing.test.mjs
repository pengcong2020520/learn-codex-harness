import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { replicaTailMissing } from '../server/modules/replication/loss.mjs';
import { Repository } from '../server/modules/data/repository.mjs';
import { MessageService } from '../server/modules/messages/index.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { AppError } from '../shared/errors.mjs';
import { ReplicationStore, MISSING_SESSION_MESSAGE } from '../server/modules/replication/store.mjs';
import { replicaHomeMissing } from '../server/modules/replication/index.mjs';
import { tempRoot } from './helpers.mjs';
import { fixedAccounts, httpFixture, request, OWNER_A } from './accounts-fixture.mjs';

test('接管时只把 ENOENT 当作 home 缺失，权限错误不能伪装成数据丢失', t => {
  const root = tempRoot(t), record = { user_id: OWNER_A, uid: 10001, codex_home: path.join(root, '.data/users', OWNER_A, 'codex') };
  assert.equal(replicaHomeMissing(root, record), true);
  assert.equal(replicaHomeMissing(root, undefined), true);
  fs.mkdirSync(record.codex_home, { recursive: true });
  assert.equal(replicaHomeMissing(root, record), false);
  t.mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  assert.throws(() => replicaHomeMissing(root, record), { code: 'EACCES' });
  t.mock.restoreAll();
});

test('缺失 home 的接管事务持久标记会话，等待任务改待核对，写失败回滚', async () => {
  for (const fail of [false, true]) {
    const queries = [], db = { async query(sql, args) {
      queries.push([sql, args]);
      if (fail && sql.includes("status='needs-review'")) throw new Error('write failed');
      return { rows: sql.startsWith('SELECT c.*') ? [{ id: 'lost', epoch: '2', replication_epoch: '1', previous_primary: 'node-a' }] : [], rowCount: 1 };
    }, release() {} };
    const work = new ReplicationStore({ connect: async () => db }, 'instance').recover('bob', 2, { missingHome: true });
    if (fail) await assert.rejects(work, /write failed/); else await work;
    assert.equal(queries[0][0], 'BEGIN'); assert.equal(queries.at(-1)[0], fail ? 'ROLLBACK' : 'COMMIT');
    const marked = queries.find(([sql]) => sql.includes('replica_missing=true'));
    assert.match(marked[0], /instance_id=\$1 AND owner_id=\$2/);
    assert.deepEqual(marked[1], ['instance', 'bob', 'lost']);
    assert.equal(queries.find(([sql]) => sql.includes("status='needs-review'"))[1][3], MISSING_SESSION_MESSAGE);
    if (!fail) {
      const completed = queries.find(([sql]) => sql.includes("SET status='replica_missing'"));
      assert.match(completed[0], /\$5::boolean OR t.sequence>/);
      assert.equal(completed[1][4], true, 'missing home also loses the saved baseline');
    }
  }
});

test('HTTP：旧会话稳定返回 409 REPLICA_MISSING，新建可用，其他用户及普通 RPC 故障不误报', async t => {
  const root = tempRoot(t), rows = new Map([['lost', { id: 'lost', replica_missing: true }], ['healthy', { id: 'healthy' }]]);
  const rpc = new EventEmitter(), calls = [];
  rpc.request = async (method, params) => {
    calls.push(method);
    if (method === 'thread/resume') throw new Error('ordinary RPC failure');
    const thread = { id: 'new-thread', cwd: root, turns: [] }; rows.set(thread.id, thread);
    return { thread };
  };
  const repository = { async conversation(id) {
    if (!rows.has(id)) throw new AppError('not owned', 404, 'THREAD_NOT_FOUND');
    return rows.get(id);
  } };
  const config = { root, launch: {}, deployment: {} }, hub = { publish() {} };
  const build = () => new SessionService({ rpc, config, runtime: { workspaceDir: root }, hub, repository, redact: value => value });
  let sessions = build();
  const messages = { config, sessions, resolve: () => ({ id: 'chat', grants: [] }), legacyWorkflow: () => null, submit: MessageService.prototype.submit, snapshot: async () => ({ jobs: [] }), rpc };
  const http = httpFixture(fixedAccounts(), { config, sessions, messages, log() {} });
  t.after(() => { sessions.close(); return http.close(); });
  const auth = { token: 'unit-token' };
  for (const route of ['/state?threadId=lost', '/sessions/resume', '/events?threadId=lost', '/messages']) {
    const response = await request(http, route, { ...auth, ...(route.includes('resume') || route === '/messages' ? { body: { threadId: 'lost', clientMessageId: 'msg', text: 'hello' } } : {}) });
    assert.equal(response.statusCode, 409); assert.deepEqual(response.body.error, { code: 'REPLICA_MISSING', message: MISSING_SESSION_MESSAGE });
  }
  assert.deepEqual(calls, [], 'lost history must not reach native resume');
  const fresh = await request(http, '/sessions', { ...auth, body: {} });
  assert.equal(fresh.statusCode, 201);
  assert.equal((await request(http, '/state?threadId=' + fresh.body.id, auth)).statusCode, 200);
  assert.equal((await request(http, '/state?threadId=lost', auth)).statusCode, 409);
  assert.equal((await request(http, '/state?threadId=foreign', auth)).statusCode, 404);
  assert.equal((await request(http, '/state?threadId=healthy', auth)).statusCode, 500);
  sessions.close(); sessions = build();
  await assert.rejects(sessions.ensure('lost'), { status: 409, code: 'REPLICA_MISSING' });
  await assert.rejects(sessions.load('lost'), { status: 409, code: 'REPLICA_MISSING' });
});

test('PG 尾部判定：创建时间、完成位点、epoch、bigint 与复制边界', () => {
  const copied = { previous_primary: 'node-a', epoch: '2', replication_epoch: '1',
    created_at: '2026-01-01T00:00:00Z', replicated_at: '2026-01-02T00:00:00Z',
    last_completed_sequence: '9007199254740992', last_task_sequence: '9007199254740992' };
  for (const [patch, expected] of [
    [{}, false],
    [{ last_completed_sequence: '9007199254740993' }, true],
    [{ created_after_replication: true, created_at: '2026-01-03T00:00:00Z', last_completed_sequence: '0' }, true],
    [{ created_at: copied.replicated_at }, false],
    [{ last_completed_sequence: '9007199254740991' }, false],
    [{ epoch: '1', last_completed_sequence: '9007199254740993' }, false],
    [{ previous_primary: null, last_completed_sequence: '9007199254740993' }, false],
    [{ replication_epoch: '2', last_completed_sequence: '9007199254740993' }, false],
    [{ replication_epoch: null, replicated_at: null, last_task_sequence: null }, true],
  ]) assert.equal(replicaTailMissing({ ...copied, ...patch }), expected, JSON.stringify(patch));
});

test('home 存在：接管事务仅标记未复制的新会话和推进过的旧会话', async () => {
  const base = { previous_primary: 'node-a', epoch: '2', replication_epoch: '1',
    created_at: '2026-01-01', replicated_at: '2026-01-02', last_task_sequence: '10' };
  const rows = [
    { ...base, id: 'copied', last_completed_sequence: '10' },
    { ...base, id: 'advanced', last_completed_sequence: '11' },
    { ...base, id: 'new-empty', created_after_replication: true, created_at: '2026-01-03', last_completed_sequence: '0' },
    { ...base, id: 'new-done', created_after_replication: true, created_at: '2026-01-03', last_completed_sequence: '12' },
    { ...base, id: 'no-takeover', previous_primary: null, last_completed_sequence: '15' },
  ];
  const calls = [], db = { async query(sql, args) {
    calls.push([sql, args]); return { rows: sql.startsWith('SELECT c.*') ? rows : [], rowCount: 1 };
  }, release() {} };
  await new ReplicationStore({ connect: async () => db }, 'instance').recover('bob', 2);
  assert.deepEqual(calls.filter(([sql]) => sql.includes('replica_missing=true')).map(([, args]) => args[2]), ['advanced', 'new-empty', 'new-done']);
  assert.equal(calls.at(-1)[0], 'COMMIT');
});

test('原生恢复兜底：仅已接管且超过位点的 JSON-RPC/thread not found 映射 409 并持久化', async t => {
  const root = tempRoot(t);
  for (const [code, message, sequence, epoch, expected] of [
    [-32600, 'invalid request', '11', '2', 409],
    [-32000, 'resume failed', '11', '2', 409],
    [undefined, 'thread not found', '11', '2', 409],
    [-32600, 'thread not found', '10', '2', undefined],
    [-32600, 'thread not found', '11', '1', undefined],
    ['EPIPE', 'broken pipe', '11', '2', undefined],
    [undefined, 'unknown failure', '11', '2', undefined],
  ]) {
    const calls = [], row = { id: 'tail', owner_id: OWNER_A, cwd: root, previous_primary: 'node-a', epoch,
      replication_epoch: '1', last_sequence: sequence, last_completed_sequence: sequence, last_task_sequence: '10' };
    const db = { async query(sql, args) {
      calls.push([sql, args]);
      if (sql.includes('SET replica_missing=true')) row.replica_missing = true;
      return { rows: [row], rowCount: 1 };
    }, release() {} };
    const repository = new Repository({ query: db.query, connect: async () => db }, { instanceId: 'instance', ownerId: OWNER_A });
    const rpc = new EventEmitter(), error = Object.assign(new Error(message), { code });
    let resumes = 0; rpc.request = async () => { resumes++; throw error; };
    const sessions = new SessionService({ rpc, repository, config: { root, launch: {} },
      runtime: { workspaceDir: root }, hub: { publish() {} }, redact: v => v });
    t.after(() => sessions.close());
    await assert.rejects(sessions.load('tail'), e => expected ? e.status === 409 && e.code === 'REPLICA_MISSING' : e === error);
    assert.equal(Boolean(row.replica_missing), expected === 409);
    if (expected) {
      await assert.rejects(sessions.ensure('tail'), { code: 'REPLICA_MISSING' });
      assert.equal(resumes, 1);
      assert.ok(calls.some(([sql]) => sql.includes("status='needs-review'")));
    }
  }
});

test('会话列表把 PG 丢失标记映射为 replicaMissing', async () => {
  const repository = new Repository({ async query(sql, args) {
    assert.match(sql, /AS "replicaMissing"/);
    assert.match(sql, /t.status='replica_missing'/);
    assert.deepEqual(args, ['instance', OWNER_A, '']);
    return { rows: [{ id: 'lost', replicaMissing: true }, { id: 'new', replicaMissing: false }] };
  } }, { instanceId: 'instance', ownerId: OWNER_A });
  assert.deepEqual(await repository.listConversations(), [{ id: 'lost', replicaMissing: true }, { id: 'new', replicaMissing: false }]);
});
