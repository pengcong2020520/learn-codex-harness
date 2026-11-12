// Requires PG + Redis + listening ports + native Codex; does not call a real provider.
// Run on a non-root development machine. Linux uid/capabilities are a separate compose test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startAgentServer } from '../server/main.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { openDatabase, migrate, identity } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser, changeUser } from '../server/modules/accounts/admin.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { installToolFixture, tempRoot, cleanup, until } from './helpers.mjs';
import { responsesFixture, answer } from './responses-fixture.mjs';
const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('设置专用 DATA_TEST_DATABASE_URL 与 DATA_TEST_REDIS_URL。');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('真实 Codex + PG + HTTP：原生历史隔离、崩溃隔离、恢复、第五用户回收、禁用关闭', { timeout: 180000 }, async t => {
  const root = installToolFixture(tempRoot(t)), held = { alice: deferred(), bob: deferred() };
  const provider = await responsesFixture(root, async body => {
    const text = JSON.stringify(body.input);
    if (text.includes('HOLD_ALICE')) await held.alice.promise;
    if (text.includes('HOLD_BOB')) await held.bob.promise;
    return answer('fixture completed');
  });
  cleanup(root, () => { held.alice.resolve(); held.bob.resolve(); });
  const config = loadServerConfig(root, { CODEX_API_KEY: 'local-fixture', CODEX_BASE_URL: provider.url, CODEX_MODEL: 'local-fixture-model',
    CODEX_MODEL_CATALOG_ENABLED: 'true', CODEX_MODEL_CONTEXT_WINDOW: '128000', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
    AGENT_MEMORY_ENABLED: 'true', AGENT_MEMORY_GENERATE: 'false', AGENT_MEMORY_USE: 'false', DEMO_TIMEOUT_MS: '30000' });
  config.port = 0;
  const db = await openDatabase(databaseUrl); cleanup(root, () => db.end()); await migrate(db);
  const scope = identity(root), accounts = new AccountStore(db, scope.instanceId), users = [];
  users.push(await initializeAccounts(accounts, { ownerId: scope.ownerId, username: 'alice', password: 'fixture-password', workspace: path.join(root, 'workspace') }));
  for (const username of ['bob', 'charlie', 'delta', 'echo']) users.push(await addUser(accounts, { username, password: 'fixture-password' }));
  let app = await startAgentServer({ config, log: () => {} }); cleanup(root, () => app.close());
  const tokens = [];
  for (const user of users) {
    const response = await fetch(app.url + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password: 'fixture-password' }) });
    assert.equal(response.status, 200); tokens.push((await response.json()).token);
  }
  const api = async (index, route, body) => {
    const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${tokens[index]}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const a = await api(0, '/sessions', {}), b = await api(1, '/sessions', {});
  const aRuntime = app.runtimes.pool.entries.get(users[0].id).value, bRuntime = app.runtimes.pool.entries.get(users[1].id).value;
  assert.notEqual(aRuntime.runtime.codexHome, bRuntime.runtime.codexHome);
  assert.equal(aRuntime.runtime.codexHome, path.join(root, '.data/codex'));
  assert.equal(aRuntime.runtime.workspaceDir, path.join(root, 'workspace/users', users[0].id));
  await api(1, '/memory/contribution', { threadId: b.id, enabled: true });
  assert.equal(aRuntime.memory.effective.enabled, true);
  await api(0, '/messages', { threadId: a.id, clientMessageId: 'isolation-a', text: 'HOLD_ALICE SECRET_ALICE' });
  await api(1, '/messages', { threadId: b.id, clientMessageId: 'isolation-b', text: 'HOLD_BOB SECRET_BOB' });
  const job = (index, id) => runOwner(users[index].id, () => app.data.jobs.get(id));
  await until(async () => (await job(0, 'isolation-a'))?.status === 'running' && (await job(1, 'isolation-b'))?.status === 'running', 30000);
  await until(() => ['HOLD_ALICE', 'HOLD_BOB'].every(marker => provider.requests.some(body => JSON.stringify(body.input).includes(marker))), 30000);
  bRuntime.rpc.child.kill('SIGKILL');
  await until(async () => (await job(1, 'isolation-b'))?.status === 'unconfirmed', 30000);
  assert.equal((await job(0, 'isolation-a')).status, 'running'); assert.equal(app.messages.failure, null);
  held.alice.resolve(); held.bob.resolve();
  await until(async () => (await job(0, 'isolation-a'))?.status === 'completed', 30000);
  const restored = await api(1, '/sessions/resume', { threadId: b.id }); assert.equal(restored.id, b.id);
  assert.notStrictEqual(app.runtimes.pool.entries.get(users[1].id).value, bRuntime);
  const nativeText = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? nativeText(file) : entry.isFile() && file.endsWith('.jsonl') ? fs.readFileSync(file, 'utf8') : [];
  }).join('\n');
  const aNative = nativeText(aRuntime.runtime.codexHome), bNative = nativeText(bRuntime.runtime.codexHome);
  assert.ok(aNative.includes('SECRET_ALICE')); assert.ok(!aNative.includes('SECRET_BOB'));
  assert.ok(bNative.includes('SECRET_BOB')); assert.ok(!bNative.includes('SECRET_ALICE'));
  // Resume may expose a native inProgress turn; interrupt and settle it before testing idle eviction.
  const active = app.sessions.sessions.get(b.id)?.activeTurnId;
  if (active) await runOwner(users[1].id, () => app.rpc.request('turn/interrupt', { threadId: b.id, turnId: active }));
  await until(() => !app.sessions.sessions.get(b.id)?.activeTurnId, 30000);
  for (const index of [2, 3]) await api(index, '/sessions', {});
  // Last requests order: alice before bob, charlie, delta. Exactly alice must be evicted.
  assert.equal(app.runtimes.pool.entries.size, 4); await api(4, '/sessions', {});
  assert.equal(app.runtimes.pool.entries.size, 4); assert.ok(!app.runtimes.pool.entries.has(users[0].id));
  await changeUser(accounts, 'bob', { disable: true });
  await until(() => !app.runtimes.pool.entries.has(users[1].id), 30000);
  const denied = await fetch(app.url + '/auth/me', { headers: { authorization: `Bearer ${tokens[1]}` } }); assert.equal(denied.status, 401);
  console.log('PASS：真实 Codex rollout 按用户隔离；bob 崩溃不阻止 alice 完成；恢复重启；第五用户回收；禁用关闭。');
});
