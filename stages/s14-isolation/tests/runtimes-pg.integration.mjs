// Explicit external acceptance: requires a dedicated PostgreSQL database, no HTTP listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate, identity, transaction } from '../server/modules/data/database.mjs';
import { RuntimeStore } from '../server/modules/runtimes/store.mjs';
import { RuntimePool } from '../server/modules/runtimes/pool.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser, changeUser, guardStartup } from '../server/modules/accounts/admin.mjs';
import { Repository } from '../server/modules/data/repository.mjs';
import { PostgresJobs } from '../server/modules/data/jobs.mjs';
import { requestScope, runOwner } from '../server/modules/accounts/context.mjs';
import { EventEmitter } from 'node:events';

const url = process.env.DATA_TEST_DATABASE_URL;
if (!url) throw new Error('设置 DATA_TEST_DATABASE_URL 指向专用验收库；不读取生产 .env。');
test('PG runtimes: 重复迁移、并发 uid、原 admin 路径、禁用通知与 owner 恢复', async t => {
  const db = await openDatabase(url); t.after(() => db.end());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's14-pg-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await migrate(db); await migrate(db);
  const sql = fs.readFileSync(new URL('../server/modules/data/migrations/011-user-runtimes.sql', import.meta.url), 'utf8');
  await transaction(db, client => client.query(sql)); await transaction(db, client => client.query(sql));
  const scope = identity(root), accounts = new AccountStore(db, scope.instanceId), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const a = await initializeAccounts(accounts, { ownerId: scope.ownerId, username: 'alice', password: 'fixture-password', workspace });
  const b = await addUser(accounts, { username: 'bob', password: 'fixture-password', memorySetting: 'true' });
  const release = await guardStartup(accounts, 'true'); await release();
  const home = path.join(root, '.data/codex'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'original.jsonl'), 'native-history\n');
  const store = new RuntimeStore(db, scope.instanceId, root);
  const aRecord = await store.ensure(a.id);
  const records = await Promise.all(Array.from({ length: 4 }, () => store.ensure(b.id)));
  assert.ok(records.every(row => row.uid === records[0].uid)); assert.equal(records[0].uid, aRecord.uid + 1);
  assert.equal(aRecord.codex_home, home); assert.equal(records[0].codex_home, path.join(root, '.data/users', b.id, 'codex'));
  await store.migrateDirectories({ isolated: false, workspace }); await store.migrateDirectories({ isolated: false, workspace });
  assert.equal(fs.readFileSync(path.join(home, 'original.jsonl'), 'utf8'), 'native-history\n');
  assert.equal(fs.existsSync(records[0].codex_home), false, '其他用户目录仍按需创建');
  assert.equal((await store.ensure(a.id)).uid, aRecord.uid);
  const ownerScope = requestScope(scope.instanceId), repo = new Repository(db, ownerScope), jobs = new PostgresJobs(db, ownerScope);
  await repo.saveAgent({ hash: 'runtime-acceptance' });
  for (const user of [a, b]) await runOwner(user.id, async () => {
    await repo.bind(user.id, 'runtime-acceptance', workspace);
    await jobs.create({ id: user.id, threadId: user.id, userId: user.id, text: 'fixture', mode: 'enqueue', createdAt: Date.now() });
    await jobs.patch(user.id, { status: 'running', turnId: user.id });
  });
  const closed = [], errors = [];
  const pool = new RuntimePool({ assertEnabled: owner => store.assertEnabled(owner),
    create: async owner => ({ rpc: new EventEmitter(), close: async () => closed.push(owner) }),
    onLost: (owner, error) => runOwner(owner, () => jobs.recoverOwner(error.message)) });
  t.after(() => pool.close());
  const unlisten = await store.listen(owner => pool.disable(owner), error => errors.push(error)); t.after(unlisten);
  await pool.withOwner(a.id, () => {}); await pool.withOwner(b.id, () => {});
  await changeUser(accounts, 'bob', { disable: true });
  const deadline = Date.now() + 30000;
  while (pool.entries.has(b.id)) {
    if (Date.now() > deadline) throw new Error('禁用通知未关闭用户运行环境');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(closed.includes(b.id)); assert.ok(pool.entries.has(a.id)); assert.deepEqual(errors, []);
  assert.equal((await runOwner(a.id, () => jobs.get(a.id))).status, 'running');
  assert.equal((await runOwner(b.id, () => jobs.get(b.id))).status, 'unconfirmed');
  await assert.rejects(() => pool.withOwner(b.id, () => {}), error => error.code === 'ACCOUNT_DISABLED');
  console.log('PASS：PG 迁移幂等、uid 连续且不重复、admin 原路径保留、禁用通知仅恢复该 owner。');
});
