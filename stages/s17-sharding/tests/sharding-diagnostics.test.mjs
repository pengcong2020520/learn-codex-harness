import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { fencePool } from '../server/modules/data/write.mjs';
import { withShardUser, shardFailure } from '../server/modules/sharding/fence.mjs';
import { httpFixture, request, fixedAccounts, OWNER_A, OWNER_B } from './accounts-fixture.mjs';

function generation() {
  const logs = [], isolated = [];
  const routes = { refresh: async () => {}, routeOf: owner => owner === OWNER_A
    ? { shardId: '2', primary: 'node-c', epoch: 23 } : { shardId: '0', primary: 'node-a', epoch: 17 } };
  return { logs, isolated, nodeId: 'node-a', term: '42', routes, assert() {},
    log: value => logs.push(value), isolate: reason => isolated.push(reason) };
}
const foreign = () => Object.assign(new Error('SECRET BODY'), { code: 'SH001', table: 'resources',
  detail: JSON.stringify({ ownerId: OWNER_A, shardId: '2', primary: 'node-c', epoch: '23', nodeId: 'node-a', suppliedEpoch: '17', content: 'SECRET BODY' }) });

test('SH001：请求者是本地主用户，失败行是另一分片所有者；拒绝写入并诊断，不误隔离', async () => {
  const g = generation(), error = foreign();
  const client = { query: async sql => { if (sql.startsWith('INSERT')) throw error; return { rows: [] }; }, release() {} };
  const pool = fencePool({ connect: async () => client }, g);
  await runOwner(OWNER_B, () => assert.rejects(pool.query("INSERT INTO agent_data.resources VALUES ('SECRET BODY')"), e => e === error));
  assert.deepEqual(g.isolated, []);
  const d = error.databaseDiagnostic;
  assert.equal(d.sqlstate, 'SH001'); assert.equal(d.table, 'resources'); assert.equal(d.nodeId, 'node-a');
  assert.equal(d.epoch, '17'); assert.equal(d.shardId, '0'); assert.equal(d.term, '42');
  assert.equal(d.row.primary, 'node-c'); assert.equal(d.row.epoch, '23');
  assert.equal(d.classification, 'wrong-shard-write');
  assert.match(d.frames.join('\n'), /sharding-diagnostics.test.mjs/);
  assert.doesNotMatch(g.logs.join('\n'), /SECRET BODY|VALUES/);
});

test('SH001：自己仍相信是失败行的主才隔离；迁走、缺 owner、刷新失败的外分片都不隔离', async () => {
  for (const kind of ['stale', 'moved', 'foreign-refresh-failed', 'unknown']) {
    const g = generation(), error = foreign();
    if (kind === 'stale' || kind === 'moved') g.routes.routeOf = () => ({ primary: 'node-a', shardId: '2', epoch: 22 });
    if (kind === 'moved') g.routes.refresh = async () => { g.routes.routeOf = () => ({ primary: 'node-c', shardId: '2', epoch: 23 }); };
    if (kind === 'foreign-refresh-failed') g.routes.refresh = async () => { throw new Error('unreachable'); };
    if (kind === 'unknown') delete error.detail;
    await runOwner(OWNER_B, () => shardFailure(error, g, new Error('origin'), 'UPDATE agent_data.resources'));
    assert.equal(g.isolated.length, kind === 'stale' ? 1 : 0, kind);
    assert.equal(g.logs.length, 1, kind);
  }
});

test('数据库连接异常：checkout、语句、连接事件都先记录，再隔离；慢 rollback 不延迟隔离', async () => {
  for (const phase of ['checkout', 'statement', 'idle', 'checked-out']) {
    const g = generation(), error = Object.assign(new Error('postgres://password SECRET BODY'), { code: '08006' });
    let rollback;
    const client = Object.assign(new EventEmitter(), { release() {}, query: async sql => {
      if (phase === 'statement' && sql.startsWith('UPDATE')) throw error;
      if (phase === 'statement' && sql === 'ROLLBACK') return new Promise(resolve => { rollback = resolve; });
      return { rows: [] };
    } });
    const raw = Object.assign(new EventEmitter(), { connect: async () => { if (phase === 'checkout') throw error; return client; } });
    const pool = fencePool(raw, g);
    if (phase === 'idle') raw.emit('error', error);
    else if (phase === 'checked-out') { await pool.connect(); client.emit('error', error); }
    else {
      const pending = runOwner(OWNER_B, () => assert.rejects(pool.query('UPDATE agent_data.resources SET state=$1', ['SECRET BODY']), e => e === error));
      if (phase === 'statement') {
        while (!rollback) await new Promise(resolve => setImmediate(resolve));
        assert.equal(g.isolated.length, 1); assert.equal(g.logs.length, 1); rollback();
      }
      await pending;
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(g.isolated.length, 1, phase);
    assert.equal(JSON.parse(g.logs[0].slice('[database] '.length)).sqlstate, '08006');
    assert.doesNotMatch(g.logs.join('\n'), /password|SECRET BODY/);
  }
});

test('HTTP 500：记录 SQLSTATE/模块/节点/分片/epoch/term，不输出 SQL 值、正文或密钥', async () => {
  const g = generation();
  const http = httpFixture(fixedAccounts(), { config: { launch: {}, deployment: {}, generation: g }, log: g.log,
    knowledge: { importSource: async () => { throw Object.assign(new Error('api-key SECRET BODY'), { code: '23505', detail: 'secret duplicate' }); } } });
  const response = await withShardUser(OWNER_B, () => request(http, '/knowledge/source', { token: 'unit-token', body: { content: 'SECRET BODY' } }));
  assert.equal(response.statusCode, 500);
  const diagnostic = JSON.parse(g.logs[0].slice('[HTTP] '.length));
  assert.equal(diagnostic.sqlstate, '23505'); assert.equal(diagnostic.nodeId, 'node-a'); assert.equal(diagnostic.epoch, '17');
  assert.equal(diagnostic.term, '42'); assert.match(diagnostic.frames.join('\n'), /sharding-diagnostics.test.mjs/);
  assert.doesNotMatch(g.logs.join('\n'), /api-key|SECRET BODY|secret duplicate/);
  assert.deepEqual(g.isolated, []);
});
