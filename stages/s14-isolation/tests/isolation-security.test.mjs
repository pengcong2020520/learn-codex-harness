import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { secureTree, repairRuntimeAccess } from '../server/modules/runtimes/directories.mjs';
import { MemoryService } from '../server/modules/memory/index.mjs';
import { RuntimePool, IDLE_MS, CLOSE_TIMEOUT_MS } from '../server/modules/runtimes/pool.mjs';
import { RuntimeRouter } from '../server/modules/runtimes/router.mjs';
import { SessionService } from '../server/modules/sessions/index.mjs';
import { createRuntimes } from '../server/modules/runtimes/index.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { userSpawn } from '../server/modules/codex/launch.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const metadata = file => { const { uid, gid, mode } = fs.statSync(file); return { uid, gid, mode }; };
function files(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's14-security-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), outside = path.join(root, 'outside');
  fs.mkdirSync(home); fs.writeFileSync(outside, 'outside secret', { mode: 0o600 });
  return { root, home, outside };
}
function fdOnly(t) {
  t.mock.method(fs, 'chownSync', () => assert.fail('不得按路径 chown'));
  t.mock.method(fs, 'chmodSync', () => assert.fail('不得按路径 chmod'));
  // 离线无 SETUID/CHOWN 权限；真实 fchmod + inode 检查证明不触碰外部目标。
  t.mock.method(fs, 'fchownSync', () => {});
}
for (const repair of [false, true]) {
  const label = repair ? 'repairRuntimeAccess' : 'secureTree';
  const walk = home => repair ? repairRuntimeAccess(home) : secureTree(home, 10001, true);
  for (const when of ['before-open', 'after-open', 'hardlink']) test(`${label}: ${when} 调换不修改树外目标`, t => {
    const { home, outside } = files(t), file = path.join(home, 'native');
    fs.writeFileSync(file, 'original', { mode: 0o600 });
    const before = metadata(outside), outsideIno = fs.statSync(outside).ino;
    fdOnly(t); t.mock.method(process, 'getuid', () => 0);
    t.mock.method(fs, 'fchownSync', fd => assert.notEqual(fs.fstatSync(fd).ino, outsideIno));
    const open = fs.openSync; let swapped = false, eloop = false;
    t.mock.method(fs, 'openSync', (target, flags) => {
      assert.ok(flags & fs.constants.O_NOFOLLOW); assert.ok(flags & fs.constants.O_NONBLOCK);
      if (target !== file || swapped) return open(target, flags);
      swapped = true;
      const fd = when === 'after-open' ? open(target, flags) : null;
      fs.renameSync(file, path.join(home, 'old'));
      if (when === 'hardlink') fs.linkSync(outside, file); else fs.symlinkSync(outside, file);
      if (fd !== null) return fd;
      try { return open(target, flags); } catch (error) { eloop = error.code === 'ELOOP'; throw error; }
    });
    if (when === 'hardlink') assert.throws(() => walk(home), /硬链接/);
    else assert.doesNotThrow(() => walk(home));
    assert.ok(swapped); if (when === 'before-open') assert.ok(eloop);
    assert.deepEqual(metadata(outside), before);
  });
  test(`${label}: 跳过软链接、socket、FIFO、设备，不打开特殊文件`, t => {
    const { home, outside } = files(t), special = path.join(home, 'special');
    fs.symlinkSync(outside, path.join(home, 'link')); fs.writeFileSync(special, 'special');
    const before = metadata(outside); fdOnly(t); t.mock.method(process, 'getuid', () => 0);
    const lstat = fs.lstatSync, open = fs.openSync; let type;
    t.mock.method(fs, 'lstatSync', target => {
      const stat = lstat(target);
      if (target === special) stat.mode = (stat.mode & ~fs.constants.S_IFMT) | type;
      return stat;
    });
    t.mock.method(fs, 'openSync', (target, flags) => {
      assert.notEqual(target, special); assert.notEqual(target, path.join(home, 'link'));
      if (target === home) assert.ok(flags & fs.constants.O_DIRECTORY);
      return open(target, flags);
    });
    for (type of [fs.constants.S_IFSOCK, fs.constants.S_IFIFO, fs.constants.S_IFCHR, fs.constants.S_IFBLK]) walk(home);
    assert.deepEqual(metadata(outside), before);
  });
}
for (const when of ['before-open', 'after-open', 'wrong-owner', 'hardlink', 'special']) test(`memory: ${when}，只校验、修改和读取同一 fd`, t => {
  const uid = process.getuid(), { root, home, outside } = files(t), memories = path.join(home, 'memories');
  fs.mkdirSync(memories); const file = path.join(memories, 'memory_summary.md');
  fs.writeFileSync(file, 'own summary', { mode: 0o600 });
  const before = metadata(outside), outsideIno = fs.statSync(outside).ino, originalIno = fs.statSync(file).ino;
  fdOnly(t); t.mock.method(process, 'getuid', () => 0);
  const mutations = [];
  t.mock.method(fs, 'fchownSync', (fd, owner) => { const stat = fs.fstatSync(fd); assert.notEqual(stat.ino, outsideIno); assert.equal(owner, uid); mutations.push(stat.ino); });
  const open = fs.openSync, fstat = fs.fstatSync;
  t.mock.method(fs, 'openSync', (target, flags) => {
    if (target !== file) return open(target, flags);
    assert.ok(flags & fs.constants.O_NOFOLLOW); assert.ok(flags & fs.constants.O_NONBLOCK);
    if (when === 'wrong-owner' || when === 'special') return open(target, flags);
    const fd = when === 'after-open' ? open(target, flags) : null;
    fs.renameSync(file, path.join(memories, 'old'));
    if (when === 'hardlink') fs.linkSync(outside, file); else fs.symlinkSync(outside, file);
    return fd ?? open(target, flags);
  });
  t.mock.method(fs, 'fstatSync', fd => {
    const stat = fstat(fd);
    if (stat.ino === originalIno && when === 'wrong-owner') stat.uid = uid + 1;
    if (stat.ino === originalIno && when === 'special') stat.mode = fs.constants.S_IFIFO;
    return stat;
  });
  const service = new MemoryService({ config: { root, codexHome: home, runtimeUid: uid }, redact: String });
  service.effective = { enabled: true };
  if (when === 'after-open') assert.equal(service.summary().text, 'own summary');
  else { assert.throws(() => service.summary()); assert.ok(!mutations.includes(originalIno)); }
  assert.deepEqual(metadata(outside), before);
});

test('routing: 隔离模式无租约/已回收时 runtime 与 Agent 都不回退；本机可回退', async () => {
  for (const isolated of [true, false]) {
    const pool = new RuntimePool({ create: async () => ({ rpc: new EventEmitter(), runtime: { workspaceDir: 'private' }, agent: { name: 'private' }, close: async () => {} }) });
    const rpc = new RuntimeRouter(pool, { isolated }), shared = { workspaceDir: 'shared' };
    const session = Object.assign(Object.create(SessionService.prototype), { rpc, runtime: shared });
    const agent = rpc.agent({ name: 'shared' });
    const busy = error => error.status === 503 && error.code === 'RUNTIME_BUSY';
    const checkMissing = () => {
      if (isolated) { assert.throws(() => session.userRuntime(), busy); assert.throws(() => agent.name, busy); }
      else { assert.equal(session.userRuntime(), shared); assert.equal(agent.name, 'shared'); }
    };
    if (isolated) assert.throws(() => agent.name, busy);
    await runOwner('owner', async () => {
      checkMissing();
      await pool.withOwner('owner', async value => {
        assert.equal(session.userRuntime(), value.runtime); assert.equal(agent.name, 'private');
        await pool.remove(pool.entries.get('owner')); checkMissing();
      });
    });
    await pool.close();
  }
});

test('sweep/idleTimer: 单 owner 查询失败记录日志并继续其他 owner；LISTEN 断开仍全局 fail', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0, listenFailure, failed = 0;
  const logs = [], messages = { fail: () => { failed++; } };
  const service = createRuntimes({ config: { root: '/unused' }, data: { jobs: { list: async () => { throw new Error('query failed'); } } },
    agent: {}, tools: {}, isolated: true, log: line => logs.push(line), store: { listen: async (_, onError) => { listenFailure = onError; return async () => {}; } } });
  service.pool.now = () => now; service.pool.assertEnabled = async () => {};
  service.pool.create = async () => ({ rpc: new EventEmitter(), close: async () => {} });
  const originalBusy = service.pool.isBusy;
  service.pool.isBusy = owner => owner === 'bad' ? originalBusy(owner) : false;
  const close = await service.open(error => messages.fail(error)); t.after(close);
  for (const owner of ['bad', 'good']) await service.pool.withOwner(owner, () => {});
  now = IDLE_MS; await service.pool.sweep();
  assert.ok(service.pool.entries.has('bad')); assert.ok(!service.pool.entries.has('good')); assert.equal(failed, 0);
  t.mock.timers.tick(IDLE_MS); await tick(); await service.pool.chain;
  assert.equal(failed, 0); assert.ok(logs.length >= 2); assert.match(logs[0], /bad.*query failed/);
  listenFailure(new Error('LISTEN disconnected')); assert.equal(failed, 1);
});

for (const route of ['sweep', 'disable', 'close', 'crash']) test(`pool ${route}: close 挂起满 10 秒后同 uid SIGKILL，完成发送才释放名额`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, sendDone, closes = 0; const signals = [];
  const pool = new RuntimePool({ now: () => now, create: async () => ({
    rpc: Object.assign(new EventEmitter(), { child: { pid: 123 }, launch: { env: { PATH: '/bin', DATABASE_URL: 'secret' } } }),
    runtime: { isolated: true, uid: 10001, gid: 10001, codexHome: '/home/owner' },
    close: () => { closes++; return new Promise(() => {}); },
  }), signalProcess: (...args) => { signals.push(args); return new Promise(resolve => { sendDone = resolve; }); } });
  await pool.withOwner('owner', () => {}); now = IDLE_MS;
  const pending = route === 'sweep' ? pool.sweep() : route === 'disable' ? pool.disable('owner') : route === 'crash' ? pool.crash(pool.entries.get('owner'), new Error('crashed')) : pool.close();
  await tick(); t.mock.timers.tick(CLOSE_TIMEOUT_MS - 1); await tick();
  assert.equal(CLOSE_TIMEOUT_MS, 10000); assert.equal(signals.length, 0); assert.equal(pool.entries.size, 1);
  t.mock.timers.tick(1); await tick();
  assert.equal(signals.length, 1); assert.deepEqual(signals[0].slice(0, 2), [123, 'SIGKILL']);
  assert.equal(signals[0][2].uid, 10001); assert.equal(signals[0][2].gid, 10001); assert.equal(signals[0][2].env.DATABASE_URL, undefined);
  assert.equal(pool.entries.size, 1); sendDone(); await pending;
  assert.equal(pool.entries.size, 0); assert.equal(closes, 1); await pool.close();
});

test('userSpawn: 不传 groups，依赖 Node/libuv setgroups(0) 清空补充组', () => {
  const launch = userSpawn('/codex', [], { isolated: true, uid: 10001, gid: 10001, groups: [1000] });
  assert.deepEqual(launch.options, { uid: 10001, gid: 10001 });
  assert.equal(Object.hasOwn(launch.options, 'groups'), false);
});

test('pool: 启动超时后晚到的连接 close 挂起也在 10 秒强杀并释放名额', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let publish; const signals = [];
  const pool = new RuntimePool({ create: () => new Promise(resolve => { publish = resolve; }),
    signalProcess: async (...args) => { signals.push(args); } });
  const pending = pool.withOwner('owner', () => assert.fail('超时不能继续请求'));
  const rejected = assert.rejects(pending, error => error.code === 'RUNTIME_START_TIMEOUT');
  await tick(); t.mock.timers.tick(30000); await rejected;
  assert.equal(pool.entries.size, 1);
  publish({ rpc: Object.assign(new EventEmitter(), { child: { pid: 123 } }),
    runtime: { isolated: true, uid: 10001, gid: 10001, codexHome: '/home/owner' }, close: () => new Promise(() => {}) });
  await tick(); t.mock.timers.tick(9999); await tick();
  assert.equal(pool.entries.size, 1); assert.equal(signals.length, 0);
  t.mock.timers.tick(1); await tick();
  assert.equal(signals[0][1], 'SIGKILL'); assert.equal(pool.entries.size, 0); await pool.close();
});

test('secureTree: fstat 拒绝被替换的特殊文件，并在校验/修改失败后关闭 fd', t => {
  const { home } = files(t), file = path.join(home, 'native'); fs.writeFileSync(file, 'native');
  const ino = fs.statSync(file).ino, fstat = fs.fstatSync, opened = new Set(), open = fs.openSync, close = fs.closeSync;
  fdOnly(t);
  t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); opened.add(fd); return fd; });
  t.mock.method(fs, 'closeSync', fd => { opened.delete(fd); return close(fd); });
  t.mock.method(fs, 'fstatSync', fd => { const stat = fstat(fd); if (stat.ino === ino) stat.mode = fs.constants.S_IFIFO; return stat; });
  t.mock.method(fs, 'fchownSync', fd => assert.notEqual(fstat(fd).ino, ino));
  secureTree(home, 10001, true); assert.equal(opened.size, 0);
  t.mock.method(fs, 'fchmodSync', () => { throw new Error('chmod failed'); });
  assert.throws(() => secureTree(home, 10001, true), /chmod failed/); assert.equal(opened.size, 0);
});
