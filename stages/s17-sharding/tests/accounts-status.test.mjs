import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountStatus, runAccounts } from '../scripts/accounts.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { assertUninitialized } from '../server/modules/accounts/admin.mjs';
import { identity, migrate } from '../server/modules/data/database.mjs';

for (const [count, expected] of [[0, 'uninitialized'], [1, 'initialized'], [2, 'initialized']]) {
  test(`accounts.mjs status: ${count} 个启用账号 → ${expected}，仅查询当前实例`, async () => {
    const queries = [];
    const pool = { async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [{ n: count }] };
    } };
    assert.equal(await accountStatus(new AccountStore(pool, 'instance-test')), expected);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /^SELECT count\(\*\)::int/);
    assert.match(queries[0].sql, /instance_id=\$1 AND username IS NOT NULL AND disabled_at IS NULL/);
    assert.deepEqual(queries[0].values, ['instance-test']);
  });
}
test('status 查询失败不能伪装成未初始化', async () => {
  await assert.rejects(accountStatus({ async query() { throw new Error('database unavailable'); } }), /database unavailable/);
});
for (const [count, expected] of [[0, 'uninitialized'], [1, 'initialized']]) {
  test(`accounts.mjs status 命令输出 ${expected}、返回 0 并关闭数据库`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 's17-status-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = identity(root), migrations = [], queries = [], lines = [];
    // Capture the real migration manifest with an in-memory pool, without PostgreSQL.
    const migrationClient = { release() {}, async query(sql, values) {
      if (sql.startsWith('INSERT INTO agent_data.migrations')) migrations.push({ version: values[0], checksum: values[1] });
      return { rows: [] };
    } };
    await migrate({ connect: async () => migrationClient });
    let closed = false;
    const pool = { async query(sql, values) {
      queries.push(sql);
      if (sql === 'SELECT * FROM agent_data.migrations ORDER BY version') return { rows: migrations };
      if (sql === 'SELECT 1 FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL') return { rowCount: count };
      assert.match(sql, /^SELECT count/);
      assert.deepEqual(values, [scope.instanceId]);
      return { rows: [{ n: count }] };
    }, async end() { closed = true; } };
    const code = await runAccounts(['status'], { root, connect: async () => pool, env: {},
      output: { log: line => lines.push(line), error: message => assert.fail(message) } });
    assert.equal(code, 0);
    assert.deepEqual(lines, [expected]);
    assert.equal(closed, true);
    assert.equal(queries.length, 2);
    assert.ok(queries.every(sql => sql.startsWith('SELECT ')));
    assert.deepEqual(fs.readdirSync(path.join(root, '.data')), ['identity.json']);
    if (count) {
      // An already running agent's lock must not prevent the dedicated duplicate-init response.
      fs.writeFileSync(path.join(root, '.data/server.lock'), JSON.stringify({ pid: process.pid, instance: 'running' }));
      const errors = [];
      assert.equal(await runAccounts(['init'], { root, connect: async () => pool, env: {},
        output: { log: message => assert.fail(message), error: message => errors.push(message) } }), 3);
      assert.deepEqual(errors, ['账号已初始化，拒绝重复执行 auth:init。']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.data/server.lock'))).instance, 'running');
    }
  });
}
test('status 读取 identity 不创建或改写状态', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's17-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => identity(root, { create: false }));
  assert.deepEqual(fs.readdirSync(root), []);
  const original = identity(root);
  const file = path.join(root, '.data/identity.json');
  const before = fs.statSync(file);
  assert.deepEqual(identity(root, { create: false }), original);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});
test('重复初始化使用专用退出码 3，包括账号已全部禁用的情况', async () => {
  await assertUninitialized({ query: async () => ({ rowCount: 0 }) });
  await assert.rejects(assertUninitialized({ async query(sql) {
    assert.doesNotMatch(sql, /disabled_at/);
    return { rowCount: 1 };
  } }), error => error.exitCode === 3 && /账号已初始化/.test(error.message));
});
