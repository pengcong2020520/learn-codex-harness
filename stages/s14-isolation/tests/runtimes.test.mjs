import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RuntimePool, RUNTIME_LIMIT, IDLE_MS, START_TIMEOUT_MS } from '../server/modules/runtimes/pool.mjs';
import { RuntimeRouter, assertToolOwner } from '../server/modules/runtimes/router.mjs';
import { RuntimeStore } from '../server/modules/runtimes/store.mjs';
import { prepareDirectories, secureTree, isolationMode } from '../server/modules/runtimes/directories.mjs';
import { userEnvironment, userSpawn, signalUserProcess } from '../server/modules/codex/launch.mjs';
import { runOwner, currentIdentity } from '../server/modules/accounts/context.mjs';
import { MessageService } from '../server/modules/messages/index.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { MemoryService } from '../server/modules/memory/index.mjs';
import { EventHub } from '../server/modules/events/index.mjs';
import { accountFixture, httpFixture, request, OWNER_A as A, OWNER_B as B } from './accounts-fixture.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const owners = [A, B, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
function fixture(t, extra = {}) {
  const created = [], closed = [], lost = [], busy = new Set(); let now = 0;
  const pool = new RuntimePool({ now: () => now, isBusy: async owner => busy.has(owner), onLost: async owner => lost.push(owner),
    create: async owner => {
      created.push(owner); const rpc = new EventEmitter(); rpc.request = async (method, params) => ({ owner, method, params });
      return { rpc, owner, async close() { closed.push(owner); rpc.closing = true; } };
    }, ...extra });
  pool.on('error', error => { throw error; });
  t.after(() => pool.close());
  const router = new RuntimeRouter(pool);
  return { pool, router, created, closed, lost, busy, time: value => { now = value; }, get: owner => pool.withOwner(owner, value => value) };
}

test('pool: 第五个进程回收最久未用且空闲者；所有进程忙时 503 + Retry-After 10', async t => {
  const f = fixture(t);
  for (const [i, owner] of owners.slice(0, 4).entries()) { f.time(i); await f.get(owner); }
  f.time(4); await f.get(A); f.busy.add(B); await f.get(owners[4]);
  assert.deepEqual(f.closed, [owners[2]]); assert.equal(f.pool.entries.size, RUNTIME_LIMIT);
  for (const owner of f.pool.entries.keys()) f.busy.add(owner);
  await assert.rejects(() => f.get(owners[2]), error => error.status === 503 && error.code === 'RUNTIME_BUSY' && error.retryAfter === 10);
  assert.equal(f.created.length, 5);
});
test('pool: 活动请求与排队任务都不允许回收；10 分钟无请求才空闲回收', async t => {
  const f = fixture(t), hold = deferred();
  const lease = f.pool.withOwner(A, () => hold.promise); await tick();
  await f.get(B); f.busy.add(B); f.time(IDLE_MS); await f.pool.sweep();
  assert.deepEqual([...f.pool.entries.keys()], [A, B]);
  hold.resolve(); await lease; f.busy.clear(); f.time(IDLE_MS * 2 - 1); await f.pool.sweep();
  assert.ok(f.pool.entries.has(A)); assert.ok(!f.pool.entries.has(B));
  f.time(IDLE_MS * 2); await f.pool.sweep(); assert.equal(f.pool.entries.size, 0);
});
test('single-flight: 并发首次请求共享一个启动过程，启动中也占名额', async t => {
  const start = deferred(), created = [];
  const f = fixture(t, { create: async owner => { created.push(owner); await start.promise; return { rpc: new EventEmitter(), close: async () => {} }; } });
  const requests = Array.from({ length: 10 }, () => f.get(A)); await tick();
  assert.deepEqual(created, [A]); assert.equal(f.pool.entries.size, 1);
  start.resolve(); const results = await Promise.all(requests); assert.ok(results.every(value => value === results[0]));
});
test('single-flight: 启动失败不缓存，下次请求重新启动；超时严格为 30 秒', async t => {
  let starts = 0, timeout; const durations = [], closed = [];
  const f = fixture(t, { setTimer: (callback, ms) => { timeout = callback; durations.push(ms); return 1; }, clearTimer: () => {},
    create: async (owner, signal) => { starts++; if (starts === 1) throw new Error('startup failed');
      if (starts === 2) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { rpc: new EventEmitter(), close: async () => closed.push(owner) };
    } });
  await assert.rejects(() => f.get(A), /startup failed/); assert.equal(f.pool.entries.size, 0);
  const pending = f.get(A); await tick(); timeout();
  await assert.rejects(() => pending, error => error.code === 'RUNTIME_START_TIMEOUT');
  await f.get(A); assert.equal(starts, 3); assert.ok(durations.every(ms => ms === START_TIMEOUT_MS));
});
test('crash: 只移除崩溃用户，其他连接继续使用，下次请求重启', async t => {
  const f = fixture(t), a = await f.get(A), b = await f.get(B);
  b.rpc.emit('fatal', new Error('crashed')); await f.pool.chain;
  assert.deepEqual(f.lost, [B]); assert.strictEqual(await f.get(A), a);
  assert.notStrictEqual(await f.get(B), b); assert.deepEqual(f.created, [A, B, B]);
});
test('disable: 立即关闭进程并标记该用户；启动中的用户也不能成为可用', async t => {
  const f = fixture(t); await f.get(A); await f.get(B);
  const disabling = f.pool.disable(B); await tick(); assert.ok(f.closed.includes(B)); await disabling;
  assert.deepEqual(f.lost, [B]); assert.ok(f.pool.entries.has(A));
  await assert.rejects(() => f.get(B), error => error.code === 'ACCOUNT_DISABLED');
  const pendingStart = deferred();
  const g = fixture(t, { create: async (_, signal) => { await pendingStart.promise; signal.throwIfAborted(); return {}; } });
  const request = g.get(A); await tick(); const disabled = g.pool.disable(A); pendingStart.resolve();
  await assert.rejects(() => request, /禁用/); await disabled; assert.equal(g.pool.entries.size, 0);
});
test('routing: API、后台 RPC 都绑定可信 owner；缺 owner 与跨 owner thread 拒绝', async t => {
  const f = fixture(t); f.router.ownerOf = async id => id === 'a-thread' ? A : B;
  const results = await Promise.all([A, B].map(owner => runOwner(owner, () => f.router.request('model/list', {}))));
  assert.deepEqual(results.map(result => result.owner), [A, B]);
  await runOwner(A, () => assert.rejects(() => f.router.request('thread/resume', { threadId: 'b-thread' }), error => error.status === 404));
  await assert.rejects(() => f.router.request('model/list', {}), /登录/);
  const result = await runOwner(A, () => f.router.withOwner(B, () => f.router.request('turn/interrupt', { threadId: 'b-thread' })));
  assert.equal(result.owner, B);
  const b = await f.get(B), received = [];
  f.router.sessions = { sessions: new Map([['a-thread', { ownerId: A }], ['b-thread', { ownerId: B }]]) };
  f.router.attach(b, B); f.router.on('notification', message => received.push([currentIdentity().userId, message.runtimeOwner]));
  b.rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'a-thread' } });
  b.rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'b-thread' } });
  assert.deepEqual(received, [[B, B]]);
});
test('routing: HTTP 返回 RUNTIME_BUSY 与 Retry-After，消息不被受理', async t => {
  const f = fixture(t); for (const owner of owners.slice(0, 4)) { await f.get(owner); f.busy.add(owner); }
  const { accounts, store } = await accountFixture(); store.users[0].id = owners[4];
  const token = (await accounts.login({ username: 'alice', password: 'fixture-password' }, 'peer')).token;
  let submitted = false;
  const http = httpFixture(accounts, { sessions: { rpc: f.router }, messages: { submit: () => { submitted = true; } } });
  const result = await request(http, '/messages', { token, body: {} });
  assert.equal(result.statusCode, 503); assert.equal(result.headers['retry-after'], '10');
  assert.equal(result.body.error.code, 'RUNTIME_BUSY'); assert.equal(submitted, false);
});
test('routing: 后台派发逐任务取 owner，忙用户不停止其他用户调度', async t => {
  const f = fixture(t), seen = [];
  const sessions = new EventEmitter(); sessions.sessions = new Map();
  const store = { allPending: async () => [{ threadId: 'a', userId: A, status: 'queued' }, { threadId: 'b', userId: B, status: 'queued' }], recover: async () => {} };
  const service = new MessageService({ rpc: f.router, sessions, store, config: {}, hub: new EventHub() });
  service.dispatch = async thread => { const value = await f.router.request('model/list'); seen.push([thread, value.owner]); };
  runOwner(B, () => service.schedule('a')); await tick(); await service.drain;
  assert.deepEqual(seen, [['a', A], ['b', B]]); assert.equal(service.failure, null);
  await service.close();
});
test('crash: 沿用 recoverOwner，仅该用户执行中任务待核对，排队保留且全局不失败', async t => {
  const f = fixture(t), sessions = new EventEmitter();
  sessions.sessions = new Map([['a', { ownerId: A, activeTurnId: 'ta', turns: new Map() }], ['b', { ownerId: B, activeTurnId: 'tb', turns: new Map() }]]);
  const jobs = [{ userId: A, status: 'running' }, { userId: B, status: 'running' }, { userId: B, status: 'queued' }], ended = [];
  const store = { recoverOwner: async () => { for (const job of jobs) if (job.userId === currentIdentity().userId && job.status === 'running') job.status = 'unconfirmed'; }, recover: async () => {} };
  const service = new MessageService({ rpc: f.router, sessions, store, config: {}, hub: new EventHub(), gate: { end: id => ended.push(id) } });
  await runOwner(A, () => service.failOwner(B, new Error('crash')));
  assert.deepEqual(jobs.map(job => job.status), ['running', 'unconfirmed', 'queued']); assert.deepEqual(ended, ['b']);
  assert.equal(service.failure, null); assert.equal(sessions.sessions.get('a').activeTurnId, 'ta');
  await service.close();
});
test('tool-owner: 连接用户与任务记录 owner 双重核对，不能信任 Thread id 或参数', () => {
  assert.doesNotThrow(() => assertToolOwner(A, { userId: A }, { ownerId: A }));
  for (const [task, session] of [[{ userId: B }, { ownerId: A }], [{ userId: A }, { ownerId: B }], [null, { ownerId: A }]]) {
    assert.throws(() => assertToolOwner(A, task, session), error => error.status === 403 && error.code === 'RUNTIME_OWNER_MISMATCH');
  }
});
test('environment: 最终白名单排除 DB、Redis、服务商密钥及注入型 Node/动态库变量', () => {
  const all = { PATH: '/usr/bin', LANG: 'C.UTF-8', CODEX_API_KEY: 'gateway-access', CODEX_BASE_URL: 'https://example.com/v1', HOME: '/old',
    CODEX_HOME: '/old', CODEX_SQLITE_HOME: '/old', DATABASE_URL: 'secret', REDIS_URL: 'secret', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret',
    AGENT_DB_PASSWORD: 'secret', AGENT_GATEWAY_KEY: 'secret', NODE_OPTIONS: '--require=evil', LD_PRELOAD: 'evil', CUSTOM_SECRET: 'secret' };
  assert.deepEqual(userEnvironment(all, '/runtime/codex'), { PATH: '/usr/bin', LANG: 'C.UTF-8', CODEX_API_KEY: 'gateway-access', CODEX_BASE_URL: 'https://example.com/v1',
    CODEX_HOME: '/runtime/codex', CODEX_SQLITE_HOME: '/runtime/codex', HOME: '/runtime/codex' });
});
test('spawn: umask 包装不插值命令；容器传专属 uid/gid，本机仅省略 uid/gid', () => {
  const args = ['app-server', 'with spaces', '$not-expanded'];
  assert.deepEqual(userSpawn('/codex', args, { uid: 10001, gid: 10001, isolated: true }), {
    command: '/bin/sh', args: ['-c', 'umask 0007 && exec "$0" "$@"', '/codex', ...args], options: { uid: 10001, gid: 10001 } });
  assert.deepEqual(userSpawn('/codex', args, { isolated: false }).options, {});
});
test('local-mode: 非 root 本机明确警告；容器内非 root 拒绝启动', () => {
  const logs = [];
  assert.equal(isolationMode({ uid: 1000, container: false, log: line => logs.push(line) }), false);
  assert.deepEqual(logs, ['本机开发模式：未启用系统用户隔离']);
  assert.throws(() => isolationMode({ uid: 1000, container: true }), /拒绝启动/);
  assert.equal(isolationMode({ uid: 0, container: true }), true);
});
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's14-runtimes-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('directories: 三个用户边界 2770；幂等；拒绝中间与根目录链接、硬链接', t => {
  const root = temporary(t), record = { user_id: B, uid: 10002, codex_home: path.join(root, '.data/users', B, 'codex') };
  const modes = [], chmod = fs.fchmodSync;
  t.mock.method(fs, 'fchmodSync', (fd, mode) => { modes.push([fs.fstatSync(fd).ino, mode]); return chmod(fd, mode); });
  const paths = prepareDirectories(root, record, { isolated: false });
  for (const target of Object.values(paths)) {
    assert.ok(modes.some(([file, mode]) => file === fs.statSync(target).ino && mode === 0o2770));
    assert.equal(fs.statSync(target).mode & 0o777, 0o770);
    // macOS 非特权文件系统可能清除 setgid；Linux 容器验收检查完整 2770 与 uid/gid。
  }
  assert.deepEqual(prepareDirectories(root, record, { isolated: false }), paths);
  const file = path.join(paths.codexHome, 'original'); fs.writeFileSync(file, 'native');
  fs.linkSync(file, path.join(paths.codexHome, 'hard')); assert.throws(() => secureTree(paths.codexHome, 10002, false), /硬链接/);
  fs.unlinkSync(path.join(paths.codexHome, 'hard')); fs.rmdirSync(paths.runsDir); fs.symlinkSync(paths.codexHome, paths.runsDir);
  assert.throws(() => prepareDirectories(root, record, { isolated: false }), /符号链接/);
});
test('secureTree: 跳过 Codex arg0/auth 软链接，树外目标属主与模式不变', async t => {
  for (const isolated of [false, true]) await t.test(`isolated=${isolated}`, t => {
    const root = temporary(t), home = path.join(root, 'codex'), outside = path.join(root, 'outside');
    const arg0 = path.join(home, 'tmp/arg0/codex-arg0-test');
    fs.mkdirSync(arg0, { recursive: true }); fs.mkdirSync(outside);
    const binary = path.join(outside, 'codex'), auth = path.join(outside, 'auth.json');
    fs.writeFileSync(binary, 'external executable', { mode: 0o755 });
    fs.writeFileSync(auth, '{}', { mode: 0o600 });
    for (const name of ['apply_patch', 'applypatch', 'codex-linux-sandbox', 'codex-execve-wrapper']) fs.symlinkSync(binary, path.join(arg0, name));
    fs.symlinkSync(auth, path.join(home, 'auth.json'));
    fs.symlinkSync(outside, path.join(home, 'external-dir'));
    fs.symlinkSync(home, path.join(home, 'cycle'));
    fs.symlinkSync(path.join(outside, 'missing'), path.join(home, 'dangling'));
    const metadata = target => { const { uid, gid, mode } = fs.lstatSync(target); return { uid, gid, mode }; };
    const targets = [outside, binary, auth], before = targets.map(metadata);
    const changed = [], chmod = fs.fchmodSync, opened = new Map(), open = fs.openSync;
    t.mock.method(fs, 'openSync', (target, flags) => { const fd = open(target, flags); opened.set(fd, target); return fd; });
    const checkTarget = target => {
      assert.ok(!fs.lstatSync(target).isSymbolicLink(), `不能修改软链接：${target}`);
      assert.ok(target === home || target.startsWith(home + path.sep), `不能修改树外目标：${target}`);
    };
    // 非 root 离线测试记录 chown 调用，真实执行 chmod；Linux uid 集成测试验证属主迁移。
    t.mock.method(fs, 'fchownSync', fd => { const target = opened.get(fd); checkTarget(target); changed.push(target); });
    t.mock.method(fs, 'fchmodSync', (fd, mode) => { checkTarget(opened.get(fd)); return chmod(fd, mode); });
    const native = path.join(home, 'native'); fs.writeFileSync(native, 'session', { mode: 0o600 });
    secureTree(home, 10002, isolated);
    secureTree(home, 10002, isolated); // Codex 留下这些链接后再次启动仍成功。
    assert.deepEqual(targets.map(metadata), before);
    assert.equal(fs.statSync(native).mode & 0o777, 0o660);
    assert.equal(fs.readlinkSync(path.join(home, 'auth.json')), auth);
    assert.equal(changed.includes(native), isolated);
    assert.throws(() => secureTree(path.join(home, 'external-dir'), 10002, isolated), /符号链接/);
    assert.throws(() => secureTree(path.join(home, 'external-dir/auth.json'), 10002, isolated), /符号链接/);
  });
});
test('secureTree: 跳过 socket、FIFO 与设备，不修改权限', t => {
  const root = temporary(t), special = path.join(root, 'special'); fs.writeFileSync(special, '', { mode: 0o600 });
  const lstat = fs.lstatSync, chmod = fs.fchmodSync, before = lstat(special);
  let type;
  // 离线沙箱禁止 socket listen；仅替换 lstat 类型，真实 socket 另见 Linux uid 集成测试。
  t.mock.method(fs, 'lstatSync', target => {
    const info = lstat(target);
    if (target === special) info.mode = (info.mode & ~fs.constants.S_IFMT) | type;
    return info;
  });
  t.mock.method(fs, 'fchownSync', fd => { assert.notEqual(fs.fstatSync(fd).ino, before.ino); });
  t.mock.method(fs, 'fchmodSync', (fd, mode) => { assert.notEqual(fs.fstatSync(fd).ino, before.ino); return chmod(fd, mode); });
  for (type of [fs.constants.S_IFSOCK, fs.constants.S_IFIFO, fs.constants.S_IFCHR, fs.constants.S_IFBLK]) {
    for (const isolated of [false, true]) secureTree(root, 10002, isolated);
  }
  const after = lstat(special);
  assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode]);
});
test('secureTree: 拒绝树外文件的硬链接，原文件属主与模式不变', t => {
  const root = temporary(t), home = path.join(root, 'codex'), original = path.join(root, 'original');
  fs.mkdirSync(home); fs.writeFileSync(original, 'external', { mode: 0o600 });
  fs.linkSync(original, path.join(home, 'hard'));
  const before = fs.statSync(original);
  t.mock.method(fs, 'fchownSync', fd => { assert.notEqual(fs.fstatSync(fd).ino, before.ino); });
  for (const isolated of [false, true]) assert.throws(() => secureTree(home, 10002, isolated), /硬链接/);
  const after = fs.statSync(original);
  assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode]);
});
test('memory: 每用户只读自己的 CODEX_HOME，开关与摘要不串用户', async t => {
  const root = temporary(t), services = [];
  for (const [index, owner] of [A, B].entries()) {
    const home = path.join(root, '.data/users', owner, 'codex'); fs.mkdirSync(path.join(home, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(home, 'memories/memory_summary.md'), owner);
    const service = new MemoryService({ config: { root, codexHome: home, memory: {} }, redact: String });
    service.effective = { enabled: index === 1 }; services.push(service);
  }
  assert.equal((await services[0].summary()).text, ''); assert.equal((await services[1].summary()).text, B);
  assert.match((await services[1].snapshot()).directory, new RegExp(B));
});
// SQL double verifies transaction/allocator semantics, real PG test separately validates locks and constraints.
export function runtimeStoreFixture(root) {
  const rows = [], calls = []; const client = { release() {}, async query(sql, args = []) {
    calls.push(sql);
    if (sql.startsWith('SELECT disabled_at')) return { rows: [{ username: 'example', disabled_at: null }] };
    if (sql.startsWith('SELECT *')) return { rows: rows.filter(row => row.user_id === args[1]) };
    if (sql.startsWith('SELECT id')) return { rows: [{ id: A }] };
    if (sql.startsWith('INSERT')) { const row = { instance_id: args[0], user_id: args[1], uid: 10001 + rows.length, codex_home: args[2] }; rows.push(row); return { rows: [row] }; }
    return { rows: [] };
  } };
  return { store: new RuntimeStore({ connect: async () => client }, A, root), calls, rows };
}
test('uid: 从 10001 顺序分配，同号私有组；重复 ensure 保留 admin 原路径与 uid', async t => {
  const root = temporary(t), f = runtimeStoreFixture(root);
  const a = await f.store.ensure(A), b = await f.store.ensure(B);
  assert.equal(a.uid, 10001); assert.equal(b.uid, 10002); assert.equal(a.codex_home, path.join(root, '.data/codex'));
  assert.equal(b.codex_home, path.join(root, '.data/users', B, 'codex'));
  assert.deepEqual(await f.store.ensure(A), a); assert.equal(f.rows.length, 2);
  assert.equal(f.calls.filter(sql => sql.includes('pg_advisory_xact_lock')).length, 3);
  assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 3);
});
test('migration: 新表与禁用通知 SQL 可重复执行；compose 最小能力且无权限绕过', () => {
  const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const sql = read('server/modules/data/migrations/011-user-runtimes.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_data.user_runtimes/); assert.match(sql, /uid integer NOT NULL UNIQUE CHECK \(uid >= 10001\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION/); assert.match(sql, /DROP TRIGGER IF EXISTS/); assert.match(sql, /pg_notify\('agent_runtime_disabled'/);
  const agent = read('compose.yaml').split('  agent:\n')[1];
  assert.match(agent, /user: "0:1000"/); assert.match(agent, /cap_drop: \[ALL\]/);
  assert.match(agent, /cap_add: \[SETUID, SETGID, CHOWN, FOWNER\]/); assert.match(agent, /security_opt: \[no-new-privileges:true\]/);
  assert.doesNotMatch(agent, /DAC_OVERRIDE|privileged/); assert.match(read('Dockerfile'), /USER node/);
});

test('single-flight: 超时立即拒绝请求，晚到连接清理前仍占名额，不出现第五个进程', async t => {
  const late = deferred(), callbacks = [], closed = [];
  const f = fixture(t, { setTimer: callback => { callbacks.push(callback); return callbacks.length; }, clearTimer: () => {},
    create: async owner => owner === A ? late.promise : ({ rpc: new EventEmitter(), close: async () => {} }) });
  const request = f.get(A); await tick();
  for (const owner of owners.slice(1, 4)) { await f.get(owner); f.busy.add(owner); }
  callbacks[0](); await assert.rejects(() => request, error => error.code === 'RUNTIME_START_TIMEOUT');
  assert.equal(f.pool.entries.get(A).state, 'closing');
  await assert.rejects(() => f.get(owners[4]), error => error.code === 'RUNTIME_BUSY');
  late.resolve({ rpc: new EventEmitter(), close: async () => closed.push(A) }); await tick();
  assert.deepEqual(closed, [A]); assert.ok(!f.pool.entries.has(A)); await f.get(owners[4]);
});

test('runtime-assembly: 两个用户实际组装独立 cwd/Skill/记忆，恢复会话与工具回调经过 owner 核对', async t => {
  const { createRuntimes } = await import('../server/modules/runtimes/index.mjs');
  const { AgentDefinition } = await import('../server/modules/agents/index.mjs');
  const { PermissionGate } = await import('../server/modules/permissions/index.mjs');
  const { loadServerConfig } = await import('../server/modules/config/index.mjs');
  const { installToolFixture, tempRoot, fixture: environment } = await import('./helpers.mjs');
  const original = installToolFixture(tempRoot(t), { article: true });
  const root = fs.realpathSync(original), config = loadServerConfig(root, environment);
  const base = new AgentDefinition(root), conversations = new Map(), native = new Map(), records = new Map(), tasks = new Map(), calls = [], toolCalls = [];
  const repository = { saveAgent: async () => {}, bind: async (id, hash, cwd) => conversations.set(id, { id, owner_id: currentIdentity().userId, agent_hash: hash, cwd }),
    conversation: async id => { const row = conversations.get(id); if (row?.owner_id !== currentIdentity()?.userId) throw Object.assign(new Error('missing'), { status: 404 }); return row; }, recordArtifacts: async () => {} };
  base.repository = repository; base.configure(config, { workspaceDir: base.workspacePath });
  const store = { assertEnabled: async () => {}, ensure: async owner => {
    if (!records.has(owner)) records.set(owner, { user_id: owner, uid: 10001 + records.size, codex_home: owner === A ? path.join(root, '.data/codex') : path.join(root, '.data/users', owner, 'codex') });
    return records.get(owner);
  }, listen: async () => async () => {} };
  const data = { scope: { instanceId: A }, repository, jobs: { list: async () => [...tasks.values()].filter(task => task.userId === currentIdentity().userId), get: async id => tasks.get(id) } };
  const gate = new PermissionGate({ scope: { get ownerId() { return currentIdentity().userId; } }, agent: base });
  const tools = { gate, configuration: () => ({}), dynamicTools: () => [], verify: async (registry, threadId, rpc) => { await rpc.request('mcpServerStatus/list'); },
    registry: { compatibilityVersion: 'fixture', call: async (params, context) => { toolCalls.push(context.permissionContext.ownerId); return { success: true }; } } };
  const makeConnection = ({ runtime }) => {
    const rpc = new EventEmitter(); rpc.open = async () => {};
    rpc.close = async () => { rpc.closing = true; };
    rpc.request = async (method, params) => {
      calls.push([runtime.ownerId, method, params]);
      if (method === 'skills/list') return { data: [{ skills: base.skills.map(skill => ({ path: path.join(runtime.codexHome, 'skills', skill.id, 'SKILL.md'), name: skill.id, enabled: true })) }] };
      if (method === 'config/read') return { config: { features: { memories: config.memory.enabled, shell_tool: false, apply_patch_freeform: false }, memories: {
        use_memories: config.memory.use, generate_memories: config.memory.generate, extract_model: config.memory.extractModel,
        consolidation_model: config.memory.consolidationModel, min_rollout_idle_hours: config.memory.minIdleHours } } };
      if (method === 'thread/start') {
        const thread = { id: runtime.ownerId, cwd: params.cwd, turns: [] }; native.set(thread.id, thread); return { thread, model: 'fixture' };
      }
      if (method === 'thread/resume') return { thread: { ...native.get(params.threadId), cwd: params.cwd }, model: 'fixture' };
      return {};
    };
    return rpc;
  };
  const service = createRuntimes({ config, data, agent: base, tools, redact: String, log: () => {}, isolated: false, store, connection: makeConnection });
  t.after(() => service.rpc.close()); config.agent = service.agent; gate.agent = service.agent;
  const sessions = new SessionService({ rpc: service.rpc, config, runtime: { workspaceDir: base.workspacePath }, hub: new EventHub(), tools, repository, redact: String });
  t.after(() => sessions.close()); service.attach({ sessions, messages: { failOwner: async () => {} } });
  for (const owner of [A, B]) await service.rpc.withOwner(owner, async value => {
    await sessions.create();
    assert.equal(value.runtime.workspaceDir, path.join(root, 'workspace/users', owner));
    assert.equal(value.runtime.uid, value.runtime.gid);
    const input = config.agent.input('$write-article');
    assert.equal(input.find(item => item.type === 'skill').path, path.join(value.runtime.codexHome, 'skills/write-article/SKILL.md'));
    await service.beforeTurn();
  });
  assert.deepEqual([...conversations.values()].map(row => row.owner_id), [A, B]);
  assert.ok(calls.filter(([, method]) => method === 'skills/list').length >= 4);
  // Two users have one stable contract, but distinct executable Skill paths.
  assert.equal(service.pool.entries.get(A).value.agent.descriptor.hash, service.pool.entries.get(B).value.agent.descriptor.hash);
  await service.pool.serial(() => service.pool.remove(service.pool.entries.get(B)));
  await service.rpc.withOwner(B, () => sessions.ensure(B));
  assert.equal(calls.filter(([owner, method]) => owner === B && method === 'thread/resume').length, 1);
  assert.equal(calls.find(([owner, method]) => owner === B && method === 'thread/resume')[2].cwd, path.join(root, 'workspace/users', B));
  const task = { id: 'task-b', userId: B, threadId: B, status: 'running' }; tasks.set(task.id, task);
  runOwner(B, () => gate.start(task)); gate.started(B, 'turn-b'); sessions.recordTurn(B, { id: 'turn-b', status: 'inProgress', items: [] });
  const params = { threadId: B, turnId: 'turn-b', callId: 'call', tool: 'read_file' };
  assert.equal((await service.pool.entries.get(B).value.rpc.toolHandler(params, {})).success, true);
  await assert.rejects(() => service.pool.entries.get(A).value.rpc.toolHandler(params, {}), error => error.code === 'RUNTIME_OWNER_MISMATCH');
  assert.deepEqual(toolCalls, [B]);
});


test('termination: 关闭信号发送器使用目标 uid/gid 与白名单，不申请 KILL 能力', async () => {
  let captured;
  await signalUserProcess(123, 'SIGTERM', { uid: 10001, gid: 10001, env: { HOME: '/runtime' } }, (...args) => {
    captured = args; const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
  });
  assert.deepEqual(captured, ['/bin/sh', ['-c', 'kill -s "$1" "$2"', 'runtime-signal', 'TERM', '123'],
    { uid: 10001, gid: 10001, env: { HOME: '/runtime' }, stdio: 'ignore' }]);
  assert.throws(() => signalUserProcess(-1, 'SIGKILL', {}), /无效/);
});

test('routing: 后台某 owner 容量繁忙保持排队，继续派发其他 owner', async t => {
  const f = fixture(t, { assertEnabled: async owner => { if (owner === A) throw Object.assign(new Error('busy'), { code: 'RUNTIME_BUSY' }); } });
  const sessions = new EventEmitter(); sessions.sessions = new Map(); const seen = [];
  const pending = [{ threadId: 'a', userId: A, status: 'queued' }, { threadId: 'b', userId: B, status: 'queued' }];
  const service = new MessageService({ rpc: f.router, sessions, config: {}, hub: new EventHub(), store: { allPending: async () => pending, recover: async () => {} } });
  service.dispatch = async id => seen.push([id, currentIdentity().userId]);
  service.failOwner = async () => assert.fail('容量不足不能把排队任务变成待核对');
  service.schedule('a'); await tick(); await service.drain;
  assert.deepEqual(seen, [['b', B]]); assert.equal(service.failure, null); assert.equal(pending[0].status, 'queued'); await service.close();
});
test('crash: 后台超时中断从任务取 owner，中断连接失败不触发全局 fail', async t => {
  const f = fixture(t), seen = [], recovered = [], sessions = new EventEmitter();
  const job = { id: 'b-task', threadId: 'b-thread', userId: B, status: 'starting' };
  sessions.sessions = new Map(); sessions.getTurn = () => ({ status: 'inProgress' });
  f.router.request = async method => { seen.push([method, currentIdentity().userId]); throw new Error('connection lost'); };
  const service = new MessageService({ rpc: f.router, sessions, config: { turnTimeoutMs: 1, launch: {} }, hub: new EventHub(),
    store: { get: async () => job, patch: async () => true, pause: async () => {}, recover: async () => {} } });
  service.failOwner = async owner => recovered.push(owner);
  const completed = deferred(), recover = service.failOwner;
  service.failOwner = async owner => { await recover(owner); completed.resolve(); };
  await runOwner(A, () => service.bind(job.id, 'b-turn'));
  // Keep the test alive while the production timer is unref'ed.
  const hold = setTimeout(() => completed.reject(new Error('timer did not run')), START_TIMEOUT_MS);
  try { await completed.promise; } finally { clearTimeout(hold); }
  assert.deepEqual(seen, [['turn/interrupt', B]]); assert.deepEqual(recovered, [B]); assert.equal(service.failure, null); await service.close();
});

test('pool: 四个并发启动占满名额，第五个请求不能启动或回收启动中的进程', async t => {
  const opening = deferred(), created = [];
  const f = fixture(t, { create: async owner => { created.push(owner); await opening.promise; return { rpc: new EventEmitter(), close: async () => {} }; } });
  const requests = owners.slice(0, 4).map(owner => f.get(owner)); await tick();
  assert.equal(created.length, 4);
  await assert.rejects(() => f.get(owners[4]), error => error.code === 'RUNTIME_BUSY');
  assert.equal(created.length, 4); opening.resolve(); await Promise.all(requests);
});
