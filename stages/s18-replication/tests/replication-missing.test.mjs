import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
      return { rows: [], rowCount: 1 };
    }, release() {} };
    const work = new ReplicationStore({ connect: async () => db }, 'instance').recover('bob', 2, { missingHome: true });
    if (fail) await assert.rejects(work, /write failed/); else await work;
    assert.equal(queries[0][0], 'BEGIN'); assert.equal(queries.at(-1)[0], fail ? 'ROLLBACK' : 'COMMIT');
    const marked = queries.find(([sql]) => sql.includes('replica_missing=true'));
    assert.match(marked[0], /instance_id=\$1 AND owner_id=\$2/);
    assert.deepEqual(marked[1], ['instance', 'bob']);
    assert.equal(queries.find(([sql]) => sql.includes("status='needs-review'"))[1][2], MISSING_SESSION_MESSAGE);
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
  const http = httpFixture(fixedAccounts(), { config, sessions, messages: { snapshot: async () => ({ jobs: [] }) }, log() {} });
  t.after(() => { sessions.close(); return http.close(); });
  const auth = { token: 'unit-token' };
  for (const route of ['/state?threadId=lost', '/sessions/resume']) {
    const response = await request(http, route, { ...auth, ...(route.includes('resume') ? { body: { threadId: 'lost' } } : {}) });
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
