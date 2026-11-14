import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapAdmin, runBootstrap } from '../scripts/admin-bootstrap.mjs';
import { encodeBootstrap, decodeBootstrap } from '../server/modules/accounts/bootstrap.mjs';
import { hashPassword } from '../server/modules/accounts/password.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';

const credentials = { username: 'admin', hash: await hashPassword('test-bootstrap-password') };
const encoded = encodeBootstrap(credentials);
test('管理员引导编码无美元符号，严格校验编码、JSON、用户名、哈希且不回显值', async () => {
  assert.doesNotMatch(encoded, /\$/);
  assert.deepEqual(decodeBootstrap(encoded), credentials);
  const json = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const value of ['secret$invalid', encoded + '=', 'a', Buffer.from('secret-invalid-json').toString('base64url'), json(null), json([]), json({ ...credentials, username: '../admin' }), json({ ...credentials, username: 'ADMIN' }), json({ ...credentials, hash: 'secret-invalid-hash' }), json({ ...credentials, password: 'secret-extra-value' })]) {
    assert.throws(() => decodeBootstrap(value), error => {
      assert.match(error.message, /AGENT_ADMIN_BOOTSTRAP 格式无效/);
      assert.equal(error.message.includes(value), false);
      return true;
    });
    const logs = [];
    const result = await runBootstrap({ env: { AGENT_ADMIN_BOOTSTRAP: value }, connect: async () => assert.fail('格式错误不得连接数据库'), error: line => logs.push(line) });
    assert.equal(result, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /AGENT_ADMIN_BOOTSTRAP.*格式/);
    assert.equal(logs[0].includes(value), false);
  }
});
for (const existing of [false, true]) test(`管理员引导在事务锁内${existing ? '跳过已有账号' : '创建首个账号'}，不重复写入`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownerId = '11111111-1111-4111-8111-111111111111', statements = [], logs = [];
  let account = existing, inserts = 0;
  const client = { release() {}, async query(sql, values) {
    statements.push(sql);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [], rowCount: null };
    if (sql === 'SELECT 1 FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL') return { rows: account ? [{ '?column?': 1 }] : [], rowCount: Number(account) };
    if (sql.startsWith('INSERT INTO agent_data.users')) { inserts++; account = true; assert.deepEqual(values, ['test-instance', ownerId, 'admin', credentials.hash]); return { rows: [], rowCount: 1 }; }
    assert.fail(`意外 SQL：${sql}`);
  } };
  const store = new AccountStore({ connect: async () => client }, 'test-instance');
  const options = { ownerId, workspace: root, log: line => logs.push(line) };
  const first = await bootstrapAdmin(store, encoded, options);
  assert.equal(first?.username, existing ? undefined : 'admin');
  assert.equal(await bootstrapAdmin(store, encoded, options), null);
  assert.equal(inserts, existing ? 0 : 1);
  assert.equal(statements[0], 'BEGIN');
  assert.match(statements[1], /pg_advisory_xact_lock/);
  assert.match(statements[2], /username IS NOT NULL/);
  assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(logs.at(-1), '已有账号，跳过引导管理员');
  assert.equal(JSON.stringify(logs).includes(credentials.hash), false);
  assert.equal(JSON.stringify(logs).includes(encoded), false);
});
test('旧配置未提供引导值时不连接数据库', async () => {
  assert.equal(await runBootstrap({ env: {}, connect: async () => assert.fail('旧配置不触发引导') }), 0);
});
test('引导连接错误不回显数据库口令、哈希或原始错误', async () => {
  const logs = [];
  assert.equal(await runBootstrap({ env: { AGENT_ADMIN_BOOTSTRAP: encoded }, connect: async () => { throw new Error(encoded); }, error: line => logs.push(line) }), 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes(encoded), false);
});
