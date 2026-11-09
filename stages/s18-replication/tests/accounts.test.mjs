import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { hashPassword, verifyPassword, tokenHash, SCRYPT_OPTIONS } from '../server/modules/accounts/password.mjs';
import { Accounts, ABSOLUTE_MS, IDLE_MS } from '../server/modules/accounts/index.mjs';
import { LoginLimits } from '../server/modules/accounts/limits.mjs';
import { runOwner, runIdentity, currentIdentity, requestScope } from '../server/modules/accounts/context.mjs';
import { guardStartup, initializeAccounts, changeUser, addUser } from '../server/modules/accounts/admin.mjs';
import { createUserFileTools, moveLegacyWorkspace } from '../server/modules/accounts/workspace.mjs';
import { Repository } from '../server/modules/data/repository.mjs';
import { PostgresJobs } from '../server/modules/data/jobs.mjs';
import { Resources } from '../server/modules/data/resources.mjs';
import { KnowledgeService } from '../server/modules/knowledge/index.mjs';
import { EventHub } from '../server/modules/events/index.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { MessageService } from '../server/modules/messages/index.mjs';
import { FakeRpc } from './helpers.mjs';
import { saveCredentials, readCredentials } from '../client/modules/connection/credentials.mjs';
import { publishConnection, createLifecycle } from '../server/modules/lifecycle/index.mjs';
import { OWNER_A, OWNER_B, accountFixture, httpFixture, request } from './accounts-fixture.mjs';

const missing = error => error.status === 404 && error.code === 'NOT_FOUND';
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 's18-replication-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('hash: scrypt 参数、随机盐、正确密码、错误密码与恒定时间比较', async () => {
  assert.deepEqual([SCRYPT_OPTIONS.N, SCRYPT_OPTIONS.r, SCRYPT_OPTIONS.p], [2 ** 15, 8, 1]);
  const first = await hashPassword('fixture-password'), second = await hashPassword('fixture-password');
  assert.notEqual(first, second); assert.equal(first.split('$')[4].length, 32);
  assert.equal(await verifyPassword('fixture-password', first), true);
  assert.equal(await verifyPassword('wrong', first), false);
  assert.equal(await verifyPassword('fixture-password', 'broken'), false);
  assert.match(fs.readFileSync(new URL('../server/modules/accounts/password.mjs', import.meta.url), 'utf8'), /timingSafeEqual\(actual, Buffer.from/);
});
test('hash: 未知用户和错误密码都执行一次真实 scrypt，失败文案统一', async () => {
  let calls = 0;
  const f = await accountFixture({ verify: (password, hash) => verifyPassword(password, hash, (...args) => { calls++; return promisify(scrypt)(...args); }) });
  const errors = [];
  for (const username of ['missing', 'alice']) {
    try { await f.accounts.login({ username, password: 'wrong' }, 'peer'); } catch (error) { errors.push([error.status, error.code, error.message]); }
  }
  assert.equal(calls, 2); assert.deepEqual(errors[0], errors[1]);
});
test('tokens: 随机 32 字节，存储只含 SHA-256，绝对/闲置过期、每分钟最多触碰一次', async () => {
  let now = Date.now();
  const { accounts, store } = await accountFixture({ now: () => now });
  const login = await accounts.login({ username: ' ALICE ', password: 'fixture-password' }, 'peer');
  assert.equal(Buffer.from(login.token, 'base64url').length, 32);
  assert.equal(store.sessions[0].token_hash, tokenHash(login.token));
  assert.ok(!JSON.stringify(store).includes(login.token));
  const auth = () => accounts.authenticate(`Bearer ${login.token}`);
  assert.equal((await auth()).userId, OWNER_A); assert.equal(store.touches, 0);
  now += 59999; await auth(); assert.equal(store.touches, 0);
  now++; await auth(); await auth(); assert.equal(store.touches, 1);
  now += IDLE_MS; await assert.rejects(auth, error => error.status === 401);
  now = +new Date(store.sessions[0].created_at) + ABSOLUTE_MS;
  store.sessions[0].last_seen_at = new Date(now);
  await assert.rejects(auth, error => error.status === 401);
});
test('logout: 登出吊销全部令牌，下一次 HTTP 请求 401，认证响应 no-store', async () => {
  const { accounts } = await accountFixture(); const http = httpFixture(accounts);
  const login = await request(http, '/auth/login', { body: { username: 'alice', password: 'fixture-password' } });
  const second = await request(http, '/auth/login', { body: { username: 'alice', password: 'fixture-password' } });
  assert.equal(login.statusCode, 200); assert.equal(login.headers['cache-control'], 'no-store');
  const token = login.body.token;
  assert.equal((await request(http, '/auth/me', { token })).body.user.username, 'alice');
  assert.equal((await request(http, '/auth/logout', { token, body: {} })).statusCode, 200);
  for (const value of [token, second.body.token]) {
    const response = await request(http, '/auth/me', { token: value });
    assert.equal(response.statusCode, 401); assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await request(http, '/health')).statusCode, 200);
  assert.equal((await request(http, '/ready')).statusCode, 200);
  for (const url of ['/health', '/ready', '/auth/login']) assert.equal((await request(http, url, { headers: { origin: 'https://example.com' } })).statusCode, 403);
  await http.close();
});
test('limits: 用户名+来源 5 次、来源 20 次、15 分钟恢复，429 与 Retry-After', async () => {
  let now = 0;
  const limits = new LoginLimits({ now: () => now });
  const { accounts } = await accountFixture({ verify: async () => false, limits });
  const http = httpFixture(accounts);
  for (let i = 0; i < 5; i++) assert.equal((await request(http, '/auth/login', { body: { username: 'ALICE', password: 'wrong' } })).statusCode, 401);
  const denied = await request(http, '/auth/login', { body: { username: 'alice', password: 'wrong' } });
  assert.equal(denied.statusCode, 429); assert.equal(denied.headers['retry-after'], '900');
  for (let i = 0; i < 15; i++) assert.equal((await request(http, '/auth/login', { body: { username: `other${i}`, password: 'wrong' } })).statusCode, 401);
  assert.equal((await request(http, '/auth/login', { body: { username: 'next', password: 'wrong' } })).statusCode, 429);
  now = 15 * 60 * 1000;
  assert.equal((await request(http, '/auth/login', { body: { username: 'alice', password: 'wrong' } })).statusCode, 401);
  const concurrent = new LoginLimits(); const release = [];
  for (let i = 0; i < 5; i++) release.push(concurrent.begin('alice', 'peer'));
  assert.throws(() => concurrent.begin('alice', 'peer'), error => error.status === 429);
  release.forEach(finish => finish(true)); concurrent.begin('alice', 'peer')(true);
  await http.close();
});
test('context: 并发请求身份不串线，无上下文拒绝；任务工具绑定记录 owner', async () => {
  const scope = requestScope(OWNER_A);
  assert.throws(() => scope.ownerId, error => error.status === 401);
  const values = await Promise.all([OWNER_A, OWNER_B].map(userId => runIdentity({ userId, role: 'user', authSessionId: userId }, async () => {
    await new Promise(resolve => setImmediate(resolve)); return [scope.ownerId, currentIdentity().authSessionId];
  })));
  assert.deepEqual(values, [[OWNER_A, OWNER_A], [OWNER_B, OWNER_B]]);
  const gate = new PermissionGate({ scope, agent: { definition: { agent: { id: 'fixture' } }, assertCurrent() {} } });
  runOwner(OWNER_B, () => gate.start({ id: 'job', userId: OWNER_A, threadId: 'thread' }));
  gate.started('thread', 'turn');
  await runOwner(OWNER_B, () => gate.run(gate.forTurn('thread', 'turn'), async () => { assert.equal(scope.ownerId, OWNER_A); }));
  gate.close();
});
test('ownership: A 访问 B 的会话缓存、任务、知识库、工作区资源都得到 404 NOT_FOUND', async t => {
  const pool = { async query(sql, values) {
    if (/conversations/.test(sql)) return { rows: values[1] === OWNER_B ? [{ id: 'thread-b', owner_id: OWNER_B }] : [], rowCount: values[1] === OWNER_B ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  } };
  const scope = requestScope(OWNER_A), repo = new Repository(pool, scope);
  const rpc = new FakeRpc(), hub = new EventHub({ warn() {} });
  const sessions = new SessionService({ rpc, config: { launch: {} }, runtime: { workspaceDir: '/tmp' }, hub, redact: JSON.stringify, repository: repo });
  runOwner(OWNER_B, () => sessions.register({ thread: { id: 'thread-b' } }));
  const jobs = new PostgresJobs(pool, scope);
  const knowledge = new KnowledgeService(pool, scope, { gate: { check() { throw new Error('权限检查不能先泄露存在性'); } } });
  const resources = new Resources(pool, scope, { blobDir: path.join(temporary(t), 'blobs'), sources: [] });
  const { accounts } = await accountFixture();
  const token = (await accounts.login({ username: 'alice', password: 'fixture-password' }, 'peer')).token;
  const messages = new MessageService({ rpc, sessions: { ...sessions, on() {}, ensure: async () => {} }, config: {}, hub, store: jobs });
  const http = httpFixture(accounts, { sessions, messages, knowledge, resources });
  for (const [url, body] of [['/state?threadId=thread-b', undefined], ['/tasks/cancel', { threadId: 'thread-a', taskId: 'task-b' }], ['/knowledge/pages?kbId=foreign', undefined], [`/resources/read?id=${OWNER_B}`, undefined]]) {
    const response = await request(http, url, { token, body });
    assert.equal(response.statusCode, 404, url); assert.equal(response.body.error.code, 'NOT_FOUND');
  }
  await runOwner(OWNER_A, async () => { await assert.rejects(() => sessions.ensure('thread-b'), missing); assert.throws(() => sessions.snapshot('thread-b'), missing); });
  sessions.close(); await http.close();
});
test('workspace: 分用户物理根、相对 locator、共享组权限、拒绝 .. 与符号链接', async t => {
  const root = temporary(t), workspace = path.join(root, 'workspace');
  const files = createUserFileTools(root, { workspaceDir: workspace, sources: [{ id: 'output', locator: 'outputs', actions: ['read', 'create'] }], outputs: { directory: 'outputs', formats: ['md'] } });
  for (const userId of [OWNER_A, OWNER_B]) runOwner(userId, () => {
    files.write_file({ path: 'outputs/result.md', content: userId });
    assert.equal(files.read_file({ path: 'outputs/result.md' }).content, userId);
    assert.equal(files.workspace, path.join(workspace, 'users', userId));
    assert.equal(fs.statSync(files.workspace).mode & 0o777, 0o770);
    assert.throws(() => files.read_file({ path: 'outputs/../../escape.md' }));
  });
  runOwner(OWNER_A, () => files.write_file({ path: 'outputs/private.md', content: 'private' }));
  runOwner(OWNER_B, () => {
    assert.throws(() => files.read_file({ path: 'outputs/private.md' }), missing);
    fs.symlinkSync(path.join(workspace, 'users', OWNER_A, 'outputs'), path.join(files.workspace, 'outputs', 'linked'));
    assert.throws(() => files.read_file({ path: 'outputs/linked/private.md' }), /符号链接/);
  });
});
test('events: SSE 绑定用户，跨用户和缺 ownerId 事件不推送，补发也过滤', async () => {
  const { accounts } = await accountFixture(), warnings = [];
  const hub = new EventHub({ warn: text => warnings.push(text) });
  const http = httpFixture(accounts, { hub, sessions: { ensure: async () => {}, snapshot: id => ({ id }) }, messages: { snapshot: async () => ({ jobs: [] }) } });
  const token = (await accounts.login({ username: 'alice', password: 'fixture-password' }, 'peer')).token;
  const stream = await request(http, '/events?threadId=thread', { token });
  const initial = stream.chunks.length;
  hub.publish('queue', { secret: 'foreign' }, 'thread', OWNER_B);
  hub.publish('queue', { secret: 'missing-owner' }, 'thread');
  assert.equal(stream.chunks.length, initial); assert.equal(warnings.length, 1);
  hub.publish('queue', { own: true }, 'thread', OWNER_A);
  assert.equal(stream.chunks.length, initial + 1);
  assert.deepEqual(hub.since(hub.eventId(0), 'thread', OWNER_A).map(event => event.ownerId), [OWNER_A]);
  stream.end(); await http.close();
});
// 管理事务夹具只验证调用语义；真正 SQL/迁移重跑另见 accounts.integration.mjs。
function adminStore() {
  const state = { initialized: false, revoked: [], operations: [] };
  const client = { async query(sql) { state.operations.push(sql); return { rows: [{ locked: true }] }; }, release() {} };
  const store = { instanceId: OWNER_A, pool: { connect: async () => client },
    async query(sql, values) {
      state.operations.push(sql);
      if (sql.startsWith('SELECT 1')) return { rowCount: state.initialized ? 1 : 0 };
      if (sql.startsWith('SELECT count')) return { rows: [{ n: 1 }] };
      if (sql.startsWith('INSERT')) state.initialized = true;
      return { rowCount: 1, rows: [{ id: OWNER_A }] };
    }, async revokeAll(id) { state.revoked.push(id); } };
  return { store, state };
}
test('init: 原 owner 为首个 admin，迁移四个旧目录，已初始化拒绝重入', async t => {
  const root = temporary(t), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  for (const name of ['inputs', 'research', 'drafts', 'outputs']) { fs.mkdirSync(path.join(workspace, name)); fs.writeFileSync(path.join(workspace, name, 'old.md'), name); }
  const { store, state } = adminStore();
  const options = { ownerId: OWNER_A, username: 'ADMIN', password: 'fixture-password', workspace };
  const result = await initializeAccounts(store, options);
  assert.equal(result.id, OWNER_A); assert.equal(result.role, 'admin'); assert.equal(result.username, 'admin');
  for (const name of ['inputs', 'research', 'drafts', 'outputs']) { assert.equal(fs.existsSync(path.join(workspace, name)), false); assert.equal(fs.readFileSync(path.join(workspace, 'users', OWNER_A, name, 'old.md'), 'utf8'), name); }
  await assert.rejects(() => initializeAccounts(store, options), /已初始化/);
  assert.ok(state.operations.includes('ROLLBACK'));
  moveLegacyWorkspace(workspace, OWNER_A); // 崩溃后目录已移动的情形不覆盖、不丢失。
});
test('admin: 改密码/禁用在同一事务吊销全部令牌；每用户记忆不限制新增账号', async () => {
  const { store, state } = adminStore(); state.initialized = true;
  await changeUser(store, 'alice', { password: 'replacement' }); await changeUser(store, 'alice', { disable: true });
  assert.deepEqual(state.revoked, [OWNER_A, OWNER_A]);
  for (const memorySetting of ['true', 'false', undefined]) {
    await addUser(store, { username: 'bob', password: 'fixture-password', memorySetting });
    const release = await guardStartup(store, memorySetting); await release();
  }
  assert.ok(!state.operations.some(sql => sql.includes('accounts-memory')));
});
test('credentials: 文件 0600、绑定服务地址，connection.json 只有 url', async t => {
  const root = temporary(t), lifecycle = createLifecycle();
  const value = { url: 'http://127.0.0.1:4336', token: 'a'.repeat(43) };
  saveCredentials(root, value); assert.equal(fs.statSync(path.join(root, '.data/credentials.json')).mode & 0o777, 0o600);
  assert.deepEqual(readCredentials(root, value.url), value);
  assert.throws(() => readCredentials(root, 'https://example.com'), /重新登录/);
  publishConnection(root, value, lifecycle);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.data/connection.json'))), { url: value.url });
  await lifecycle.close();
});

test('background: 调度从持久化任务恢复各自 owner，不继承触发请求身份', async () => {
  const rpc = new FakeRpc();
  const sessions = { on() {}, off() {}, sessions: new Map(), usage: null };
  const seen = [], store = { allPending: async () => [
    { threadId: 'a', userId: OWNER_A, status: 'queued' }, { threadId: 'b', userId: OWNER_B, status: 'queued' },
  ] };
  const service = new MessageService({ rpc, sessions, hub: new EventHub(), config: {}, store });
  service.dispatch = async threadId => seen.push([threadId, currentIdentity().userId]);
  runOwner(OWNER_B, () => service.schedule('a'));
  await new Promise(resolve => setImmediate(resolve)); await service.drain;
  assert.deepEqual(seen, [['a', OWNER_A], ['b', OWNER_B]]);
  assert.equal(currentIdentity(), undefined);
});
test('background: 用量延迟写入捕获提交时 owner，不串到另一条请求', async () => {
  const { UsageService } = await import('../server/modules/usage/index.mjs');
  const owners = [], usage = new UsageService({ pool: { async query(sql, values) { owners.push(values[1]); } }, scope: requestScope(OWNER_A) });
  await Promise.all([OWNER_A, OWNER_B].map(owner => runOwner(owner, () => usage.record({ source: 'chat', model: 'example/model' }))));
  assert.deepEqual(owners, [OWNER_A, OWNER_B]);
});
test('memory: 关闭时不返回先前保留的共享摘要正文', async t => {
  const { MemoryService } = await import('../server/modules/memory/index.mjs');
  const root = temporary(t); fs.mkdirSync(path.join(root, '.data/codex/memories'), { recursive: true });
  fs.writeFileSync(path.join(root, '.data/codex/memories/memory_summary.md'), 'old private content');
  const memory = new MemoryService({ config: { root }, redact: String }); memory.effective = { enabled: false };
  assert.equal((await memory.summary()).text, '');
});
test('logging: 密码、令牌及其哈希字段脱敏', async () => {
  const { createLogRedactor } = await import('../server/modules/config/index.mjs');
  const redact = createLogRedactor();
  const text = redact({ password: 'secret-password', token: 'secret-token', password_hash: 'secret-hash', token_hash: 'secret-digest' });
  assert.doesNotMatch(text, /secret-/);
});
test('prompt: 非 TTY 逐行读取，密码不输出，登录不接受密码参数', async () => {
  const { Readable, Writable } = await import('node:stream');
  const { createPrompts } = await import('../shared/prompts.mjs');
  let output = '';
  const prompts = createPrompts(Readable.from(['alice\nfixture-password\n']), new Writable({ write(chunk, encoding, done) { output += chunk; done(); } }));
  try {
    assert.equal(await prompts.ask('用户名：'), 'alice');
    assert.equal(await prompts.ask('密码：', { secret: true }), 'fixture-password');
    assert.equal(output, '');
  } finally { prompts.close(); }
});
test('migration: 迁移登记可重入，不重复执行已登记版本；新 SQL 包含幂等约束', async () => {
  const { migrate } = await import('../server/modules/data/database.mjs');
  const rows = [], scripts = [];
  const client = { async query(sql, values) {
    if (sql === 'SELECT * FROM agent_data.migrations ORDER BY version') return { rows: [...rows] };
    if (sql === 'INSERT INTO agent_data.migrations VALUES($1,$2)') rows.push({ version: values[0], checksum: values[1] });
    else if (sql.includes('ALTER TABLE agent_data.users ADD COLUMN IF NOT EXISTS username')) scripts.push(sql);
    return { rows: [] };
  }, release() {} };
  const pool = { connect: async () => client };
  await migrate(pool); await migrate(pool);
  assert.equal(rows.length, 20); assert.equal(scripts.length, 1);
  assert.match(scripts[0], /CREATE TABLE IF NOT EXISTS agent_data.auth_sessions/);
  assert.match(scripts[0], /role IN \('admin','user'\)/);
  assert.match(scripts[0], /users_username_normalized/);
});
