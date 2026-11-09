import test from 'node:test';
import assert from 'node:assert/strict';
import { transaction } from '../server/modules/data/database.mjs';
import { fencePool } from '../server/modules/data/write.mjs';
import { withShardUser } from '../server/modules/sharding/fence.mjs';
import { hubFixture } from './hub-fixture.mjs';

function fixture(sharded = false) {
  const calls = [];
  const raw = { connect: async () => raw, release: () => calls.push('release'), query: async (sql, values) => {
    calls.push([sql, values]); return { rows: [] };
  } };
  const generation = { assert() {}, isolate: () => assert.fail('programming errors must not isolate'),
    ...(sharded ? { nodeId: 'node-a', routes: { routeOf: id => {
      assert.equal(id, 'alice'); return { epoch: 7 };
    } } } : { term: '42' }) };
  return { calls, pool: fencePool(raw, generation) };
}

test('事务选项在同一条 BEGIN 中声明，先于 term/node/epoch，再执行业务 SQL', async () => {
  for (const sharded of [false, true]) {
    const { calls, pool } = fixture(sharded);
    const value = await withShardUser('alice', () => transaction(pool, async client => {
      await client.query('SELECT 1'); return 17;
    }, { isolation: 'repeatable read', readOnly: true }));
    assert.equal(value, 17);
    assert.deepEqual(calls.map(call => Array.isArray(call) ? call[0] : call), [
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      sharded ? "SELECT set_config('app.node',$1,true),set_config('app.shard_epoch',$2,true)" : "SET LOCAL app.term = '42'",
      'SELECT 1', 'COMMIT', 'release',
    ]);
    if (sharded) assert.deepEqual(calls[1][1], ['node-a', '7']);
  }
});

test('普通事务保持 BEGIN；readOnly false 和各隔离级别按白名单构造', async () => {
  for (const [options, begin] of [
    [undefined, 'BEGIN'], [{ readOnly: true }, 'BEGIN READ ONLY'], [{ readOnly: false }, 'BEGIN READ WRITE'],
    ...['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].map(isolation =>
      [{ isolation, readOnly: false }, `BEGIN ISOLATION LEVEL ${isolation} READ WRITE`]),
  ]) {
    const { pool, calls } = fixture();
    await transaction(pool, async () => {}, options);
    assert.equal(calls[0][0], begin);
  }
  for (const options of [{ isolation: 'serializable; COMMIT' }, { isolation: null }, { readOnly: 'false' }])
    await assert.rejects(transaction({ connect: () => assert.fail('must validate before checkout') }, () => {}, options), TypeError);
});

test('BEGIN 后第一条 SET TRANSACTION 在发送到 PG 前报编程错误，回滚释放且可重用', async () => {
  for (const sharded of [false, true]) {
    for (const sql of ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      '  -- legacy snapshot\n /* options */ set\ntransaction read only',
      { text: 'SET TRANSACTION READ ONLY' }]) {
      const { pool, calls } = fixture(sharded);
      await withShardUser('alice', async () => {
        await assert.rejects(transaction(pool, client => client.query(sql)), error => {
          assert.equal(error.code, 'TRANSACTION_OPTIONS_REQUIRED');
          assert.match(error.message, /transaction\(pool, fn, \{ isolation, readOnly \}\)/);
          return true;
        });
        assert.deepEqual(calls.slice(-2), [['ROLLBACK', undefined], 'release']);
        assert.equal(calls.length, 4, 'legacy SET TRANSACTION must never reach the driver');
        await transaction(pool, client => client.query('SELECT 1'), { readOnly: true });
        assert.equal(calls[4][0], 'BEGIN READ ONLY');
        assert.deepEqual(calls.slice(-2), [['COMMIT', undefined], 'release']);
      });
    }
  }
});

test('Hub snapshot 通过 transaction 选项申请一致只读快照', async () => {
  const { hub } = hubFixture(), calls = [];
  const query = hub.pool.query.bind(hub.pool);
  hub.pool.query = (...args) => { calls.push(args[0]); return query(...args); };
  const snapshot = await hub.snapshot('bob');
  assert.equal(snapshot.user.id, 'bob');
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(calls.every(sql => !/^SET TRANSACTION/.test(sql)));
  assert.equal(calls.at(-1), 'COMMIT');
});
