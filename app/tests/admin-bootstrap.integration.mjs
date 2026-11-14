import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate, identity } from '../server/modules/data/database.mjs';
import { Accounts } from '../server/modules/accounts/index.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { hashPassword, verifyPassword } from '../server/modules/accounts/password.mjs';
import { httpFixture, request } from './accounts-fixture.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { changeUser, initializeAccounts, addUser } from '../server/modules/accounts/admin.mjs';
import { encodeBootstrap } from '../server/modules/accounts/bootstrap.mjs';
import { bootstrapAdmin } from '../scripts/admin-bootstrap.mjs';

const url = process.env.DATA_TEST_DATABASE_URL;
if (!url) throw new Error('请设置 DATA_TEST_DATABASE_URL 指向专用验收库；不读取生产 .env。');
test('真实 PostgreSQL：引导管理员并发幂等、可登录，已有禁用账号也不覆盖，坏格式失败', async t => {
  const pool = await openDatabase(url, { maintenance: true }); t.after(() => pool.end());
  await migrate(pool);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-pg-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = identity(root), store = new AccountStore(pool, legacy.instanceId), logs = [];
  const options = { ownerId: legacy.ownerId, workspace: path.join(root, 'workspace'), log: line => logs.push(line) };
  const hash = await hashPassword('test-bootstrap-password');
  const encoded = encodeBootstrap({ username: 'admin', hash });
  const results = await Promise.all([bootstrapAdmin(store, encoded, options), bootstrapAdmin(store, encoded, options)]);
  assert.equal(results.filter(Boolean).length, 1);
  const account = await store.byUsername('admin');
  assert.equal(account.id, legacy.ownerId);
  assert.equal(account.role, 'admin');
  assert.ok(await verifyPassword('test-bootstrap-password', account.password_hash));
  const login = await new Accounts(store).login({ username: 'admin', password: 'test-bootstrap-password' }, 'bootstrap-test');
  assert.equal(login.user.id, legacy.ownerId);
  await changeUser(store, 'admin', { disable: true });
  const before = await store.byUsername('admin');
  assert.equal(await bootstrapAdmin(store, encodeBootstrap({ username: 'replacement', hash }), options), null);
  assert.deepEqual(await store.byUsername('admin'), before);
  assert.equal(await store.byUsername('replacement'), undefined);
  assert.equal(logs.at(-1), '已有账号，跳过引导管理员');
  await assert.rejects(bootstrapAdmin(store, 'secret-invalid-value', options), error => /格式无效/.test(error.message) && !error.message.includes('secret-invalid-value'));
  assert.equal((await store.query('SELECT count(*)::int AS n FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL')).rows[0].n, 1);
});


test('真实 PostgreSQL：workbench 与 readiness 仅信任已认证账号的管理员角色', async t => {
  const pool = await openDatabase(url, { maintenance: true }); t.after(() => pool.end());
  await migrate(pool);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-pg-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['config', 'agents']) fs.cpSync(new URL(`../${dir}`, import.meta.url), path.join(root, dir), { recursive: true });
  const legacy = identity(root), store = new AccountStore(pool, legacy.instanceId), accounts = new Accounts(store);
  await initializeAccounts(store, { ownerId: legacy.ownerId, username: 'admin', password: 'fixture-password', workspace: path.join(root, 'workspace') });
  await addUser(store, { username: 'bob', password: 'fixture-password' });
  const config = loadServerConfig(root, { CODEX_MODEL: 'unit-model', CODEX_API_KEY: 'fixture-model-key', CODEX_BASE_URL: 'https://provider.invalid/v1' });
  const http = httpFixture(accounts, { config }); t.after(() => http.close());
  for (const [username, admin] of [['admin', true], ['bob', false]]) {
    const { token } = await accounts.login({ username, password: 'fixture-password' }, 'fixture');
    const workbench = await request(http, '/workbench?admin=true', { token });
    assert.equal(workbench.statusCode, 200);
    assert.deepEqual(workbench.body.viewer, { username, admin });
    const readiness = await request(http, '/admin/readiness?role=admin', { token });
    assert.equal(readiness.statusCode, admin ? 200 : 403);
    if (admin) assert.ok(readiness.body.unchecked.some(row => row.id === 'env-file'));
  }
});
