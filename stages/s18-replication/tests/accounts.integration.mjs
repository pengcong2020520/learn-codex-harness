// PostgreSQL only; no listener or real model. Run against a dedicated acceptance database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, identity, transaction } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { Accounts, IDLE_MS, ABSOLUTE_MS } from '../server/modules/accounts/index.mjs';
import { initializeAccounts, addUser, changeUser, guardStartup } from '../server/modules/accounts/admin.mjs';
import { tokenHash } from '../server/modules/accounts/password.mjs';
import { runOwner, requestScope } from '../server/modules/accounts/context.mjs';
import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { Resources } from '../server/modules/data/resources.mjs';
import { Repository } from '../server/modules/data/repository.mjs';
import { PostgresJobs } from '../server/modules/data/jobs.mjs';

const url = process.env.DATA_TEST_DATABASE_URL;
if (!url) throw new Error('设置 DATA_TEST_DATABASE_URL 指向专用验收库；本测试不读生产 .env。');
test('真实 PostgreSQL：可重复迁移、初始化、用户隔离、令牌吊销与每用户记忆策略', async t => {
  const pool = await openDatabase(url); t.after(() => pool.end());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's18-pg-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await migrate(pool); await migrate(pool);
  const versions = (await pool.query('SELECT version FROM agent_data.migrations ORDER BY version')).rows;
  assert.equal(versions.at(-1).version, 11);
  // 登记清单本身幂等 + 新迁移 SQL 直接重跑也幂等。
  const sql = fs.readFileSync(new URL('../server/modules/data/migrations/010-accounts.sql', import.meta.url), 'utf8');
  await transaction(pool, client => client.query(sql)); await transaction(pool, client => client.query(sql));
  const legacy = identity(root), store = new AccountStore(pool, legacy.instanceId), accounts = new Accounts(store);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  for (const area of ['inputs', 'research', 'drafts', 'outputs']) {
    fs.mkdirSync(path.join(workspace, area)); fs.writeFileSync(path.join(workspace, area, 'legacy.md'), area);
  }
  const a = await initializeAccounts(store, { ownerId: legacy.ownerId, username: 'ADMIN', password: 'fixture-password', workspace });
  assert.equal(a.id, legacy.ownerId); assert.equal(a.username, 'admin');
  await assert.rejects(() => initializeAccounts(store, { ownerId: legacy.ownerId, username: 'again', password: 'fixture-password', workspace }), /已初始化/);
  const b = await addUser(store, { username: 'BOB', password: 'fixture-password', memorySetting: 'false' });
  for (const setting of [undefined, 'true']) { const release = await guardStartup(store, setting); await release(); }
  const closeGuard = await guardStartup(store, 'false'); await closeGuard();
  const login = name => accounts.login({ username: name, password: 'fixture-password' }, 'fixture');
  const first = await login('admin'), second = await login('admin');
  const stored = (await store.query('SELECT * FROM agent_data.auth_sessions WHERE instance_id=$1')).rows;
  assert.equal(stored.length, 2); assert.ok(stored.some(row => row.token_hash === tokenHash(first.token)));
  assert.ok(!JSON.stringify(stored).includes(first.token));
  await accounts.logout(await accounts.authenticate(`Bearer ${first.token}`));
  for (const token of [first.token, second.token]) await assert.rejects(() => accounts.authenticate(`Bearer ${token}`), e => e.status === 401);
  const beforeChange = await login('bob'); await changeUser(store, 'bob', { password: 'replacement' });
  await assert.rejects(() => accounts.authenticate(`Bearer ${beforeChange.token}`), e => e.status === 401);
  const beforeDisable = await accounts.login({ username: 'bob', password: 'replacement' }, 'fixture');
  await changeUser(store, 'bob', { disable: true });
  await assert.rejects(() => accounts.authenticate(`Bearer ${beforeDisable.token}`), e => e.status === 401);
  const expiry = await login('admin');
  await store.query("UPDATE agent_data.auth_sessions SET last_seen_at=now()-interval '12 hours' WHERE instance_id=$1 AND token_hash=$2", [tokenHash(expiry.token)]);
  await assert.rejects(() => accounts.authenticate(`Bearer ${expiry.token}`), e => e.status === 401);
  await store.query("UPDATE agent_data.auth_sessions SET last_seen_at=now(),expires_at=now()-interval '1 second' WHERE instance_id=$1 AND token_hash=$2", [tokenHash(expiry.token)]);
  await assert.rejects(() => accounts.authenticate(`Bearer ${expiry.token}`), e => e.status === 401);
  const scope = requestScope(legacy.instanceId), repo = new Repository(pool, scope), jobs = new PostgresJobs(pool, scope);
  await repo.saveAgent({ hash: 's18-test' });
  await runOwner(a.id, () => repo.bind('a-thread', 's18-test', workspace));
  await runOwner(b.id, () => repo.bind('b-thread', 's18-test', workspace));
  await runOwner(b.id, () => jobs.create({ id: randomUUID(), threadId: 'b-thread', userId: b.id, text: 'private', mode: 'enqueue', createdAt: Date.now() }));
  assert.equal((await jobs.allPending()).length, 1); assert.equal((await jobs.allPending())[0].userId, b.id);
  assert.equal((await jobs.deliveries())[0].owner_id, b.id);
  await runOwner(a.id, async () => {
    await assert.rejects(() => repo.conversation('b-thread'), e => e.status === 404 && e.code === 'NOT_FOUND');
    assert.equal((await jobs.list()).length, 0);
  });
  const sources = [{ id: 'outputs', locator: 'outputs', actions: ['read', 'create'] }], outputs = { directory: 'outputs', formats: ['md'] };
  const files = createUserFileTools(root, { workspaceDir: workspace, sources, outputs });
  const resources = new Resources(pool, scope, { files, sources, outputs, blobDir: path.join(root, 'blobs') });
  const artifacts = [];
  for (const ownerId of [a.id, b.id]) artifacts.push(await runOwner(ownerId, () => resources.write_file({ path: 'outputs/same.md', content: ownerId })));
  assert.notEqual(artifacts[0].artifact.resourceId, artifacts[1].artifact.resourceId);
  await runOwner(a.id, () => assert.rejects(() => resources.readById(artifacts[1].artifact.resourceId), e => e.status === 404 && e.code === 'NOT_FOUND'));
  assert.equal(fs.readFileSync(path.join(workspace, 'users', a.id, 'inputs/legacy.md'), 'utf8'), 'inputs');
  // 专用测试库保留随机 instance 作为可查询证据；不清空已有 schema。
});
