import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readAsUser, USER_FILE_TIMEOUT_MS } from '../server/modules/runtimes/user-files.mjs';
import { prepareDirectories, migrateLegacyTree, secureDirectory, uidHasProcesses } from '../server/modules/runtimes/directories.mjs';
import { RuntimeStore } from '../server/modules/runtimes/store.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's14-user-files-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const owner = '11111111-1111-4111-8111-111111111111';

test('启动仅处理三个根目录：不枚举、stat、打开或修改用户内部 0600 文件', t => {
  const root = fixture(t), record = { user_id: owner, uid: 10001, codex_home: path.join(root, '.data/codex') };
  const paths = prepareDirectories(root, record, { isolated: false });
  for (const target of Object.values(paths)) fs.writeFileSync(path.join(target, 'private'), 'secret', { mode: 0o600 });
  const internal = target => Object.values(paths).some(dir => String(target).startsWith(dir + path.sep));
  const opened = [], owned = [], modes = [];
  const open = fs.openSync, lstat = fs.lstatSync;
  t.mock.method(fs, 'readdirSync', () => assert.fail('启动不能枚举用户树'));
  t.mock.method(fs, 'lstatSync', target => { assert.ok(!internal(target)); return lstat(target); });
  t.mock.method(fs, 'openSync', (target, flags) => {
    assert.ok(!internal(target)); opened.push(target);
    assert.ok(flags & fs.constants.O_NOFOLLOW); assert.ok(flags & fs.constants.O_DIRECTORY);
    return open(target, flags);
  });
  t.mock.method(fs, 'chownSync', () => {}); t.mock.method(fs, 'chmodSync', () => {});
  t.mock.method(fs, 'fchownSync', (fd, uid, gid) => owned.push([uid, gid]));
  t.mock.method(fs, 'fchmodSync', (fd, mode) => modes.push(mode));
  assert.deepEqual(prepareDirectories(root, record, { isolated: true }), paths);
  assert.deepEqual(opened, Object.values(paths));
  assert.deepEqual(owned, [[10001, 1000], [10001, 1000], [10001, 1000]]);
  assert.deepEqual(modes, [0o2770, 0o2770, 0o2770]);
});

test('根目录 fstat 失败或 chmod 失败均关闭 fd', t => {
  const root = fixture(t), close = fs.closeSync; let closed = 0;
  t.mock.method(fs, 'closeSync', fd => { closed++; close(fd); });
  let isDirectory = false;
  t.mock.method(fs, 'fstatSync', () => ({ isDirectory: () => isDirectory }));
  assert.throws(() => secureDirectory(root, 10001, false), /真实目录/);
  assert.equal(closed, 1);
  isDirectory = true;
  t.mock.method(fs, 'fchmodSync', () => { throw new Error('chmod failure'); });
  assert.throws(() => secureDirectory(root, 10001, false), /chmod failure/); assert.equal(closed, 2);
});

function spawnFixture(t) {
  const calls = [], child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough() });
  child.stdio = [child.stdin, child.stdout, null, new PassThrough()];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1) return child;
    const sender = new EventEmitter();
    queueMicrotask(() => { sender.emit('close', 0); child.emit('close', null, 'SIGKILL'); });
    return sender;
  });
  return { calls, child, end(text = 'private', metadata = {}) {
    child.stdout.write(text); child.stdio[3].write(JSON.stringify(metadata)); child.emit('close', 0);
  } };
}

test('readAsUser 指定 uid/gid、最小环境、stdout 为内容，服务不打开用户文件', async t => {
  const f = spawnFixture(t);
  t.mock.method(fs, 'openSync', () => assert.fail('服务不能打开用户文件'));
  const pending = readAsUser(10001, '/private/memory', { maxBytes: 64, isolated: true });
  f.end(); assert.equal((await pending).toString(), 'private');
  assert.equal(f.calls[0].command, process.execPath);
  assert.equal(f.calls[0].options.uid, 10001); assert.equal(f.calls[0].options.gid, 10001);
  assert.deepEqual(f.calls[0].options.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
  assert.equal(f.calls[0].options.cwd, '/');
});
for (const reason of ['timeout', 'limit']) test(`readAsUser ${reason}：同 uid SIGKILL 并拒绝`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = spawnFixture(t), pending = readAsUser(10001, '/private', { maxBytes: 3, isolated: true });
  const rejected = assert.rejects(pending, error => error.code === (reason === 'timeout' ? 'ETIMEDOUT' : 'ERR_USER_FILE_LIMIT'));
  if (reason === 'timeout') {
    assert.equal(USER_FILE_TIMEOUT_MS, 5000);
    t.mock.timers.tick(4999); assert.equal(f.calls.length, 1); t.mock.timers.tick(1);
  } else f.child.stdout.write('four');
  await rejected;
  assert.equal(f.calls[1].options.uid, 10001); assert.equal(f.calls[1].options.gid, 10001);
  assert.deepEqual(f.calls[1].args.slice(-2), ['KILL', '12345']);
});

test('readAsUser 本机模式直接读，超限拒绝；记忆可限长读取并返回原始大小', async t => {
  const root = fixture(t), file = path.join(root, 'private'); fs.writeFileSync(file, 'private', { mode: 0o600 });
  t.mock.method(childProcess, 'spawn', () => assert.fail('本机不得切换 uid'));
  assert.equal((await readAsUser(10001, file, { isolated: false, maxBytes: 7 })).toString(), 'private');
  await assert.rejects(readAsUser(10001, file, { isolated: false, maxBytes: 6 }), { code: 'ERR_USER_FILE_LIMIT' });
  const value = await readAsUser(10001, file, { isolated: false, maxBytes: 3, truncate: true, metadata: true });
  assert.equal(value.data.toString(), 'pri'); assert.equal(value.metadata.bytes, 7); assert.equal(value.metadata.truncated, true);
});

test('旧目录迁移不用 open；保留文件权限加 g+rw，跳过链接/特殊文件，拒绝硬链接', t => {
  const root = fixture(t), home = path.join(root, 'home'), outside = path.join(root, 'outside');
  fs.mkdirSync(home); fs.writeFileSync(outside, 'outside', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'native'), 'private', { mode: 0o701 });
  fs.symlinkSync(outside, path.join(home, 'link')); fs.writeFileSync(path.join(home, 'socket'), '');
  const lstat = fs.lstatSync, mutations = [];
  t.mock.method(fs, 'lstatSync', target => { const stat = lstat(target); if (target === path.join(home, 'socket')) stat.mode = fs.constants.S_IFSOCK; return stat; });
  t.mock.method(fs, 'openSync', () => assert.fail('迁移不能先打开旧文件'));
  t.mock.method(fs, 'lchownSync', (target, uid, gid) => mutations.push([target, uid, gid]));
  migrateLegacyTree(home, 10001);
  assert.deepEqual(mutations, [[home, 10001, 1000], [path.join(home, 'native'), 10001, 1000]]);
  assert.equal(lstat(path.join(home, 'native')).mode & 0o777, 0o761);
  assert.equal(lstat(outside).mode & 0o777, 0o600);
  fs.linkSync(outside, path.join(home, 'hard'));
  assert.throws(() => migrateLegacyTree(home, 10001), /硬链接/);
});

test('迁移持锁只执行一次、完成后写 migrated_at；运行中和失败时不标记', async t => {
  const root = fixture(t), row = { user_id: owner, uid: 10001, codex_home: path.join(root, '.data/codex'), migrated_at: null };
  const calls = [], client = { release() {}, async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT *')) return { rows: [{ ...row }] };
    if (sql.startsWith('UPDATE')) row.migrated_at = 'done';
    return { rows: [] };
  } };
  const store = new RuntimeStore({ connect: async () => client }, owner, root);
  t.mock.method(fs, 'chownSync', () => {}); t.mock.method(fs, 'fchownSync', () => {});
  let migrated = 0;
  const options = { isolated: true };
  await assert.rejects(store.migrateLegacy(row, options, { hasProcesses: () => true }), /运行中进程/);
  await assert.rejects(store.migrateLegacy(row, options, { hasProcesses: () => false, migrateTree: () => { throw new Error('failed'); } }), /failed/);
  assert.equal(row.migrated_at, null);
  const hooks = { hasProcesses: () => false, migrateTree: () => { assert.equal(row.migrated_at, null); migrated++; } };
  await store.migrateLegacy(row, options, hooks); await store.migrateLegacy(row, options, hooks);
  assert.equal(migrated, 1); assert.equal(row.migrated_at, 'done');
  assert.equal(calls.filter(sql => sql.startsWith('UPDATE')).length, 1);
  assert.ok(calls.some(sql => sql.endsWith('FOR UPDATE')));
  await store.migrateLegacy({ ...row, codex_home: '/other' }, options, { hasProcesses: () => assert.fail('非旧 admin 不能迁移') });
});

test('/proc 进程检查包含 real/effective/saved/fs uid，读取失败不放行', t => {
  t.mock.property(process, 'platform', 'linux');
  t.mock.method(fs, 'readdirSync', () => ['self', '123', '124']);
  let denied = false;
  t.mock.method(fs, 'readFileSync', file => {
    if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return file.includes('/123/') ? 'Uid:\t0\t0\t0\t0\n' : 'Uid:\t0\t10001\t0\t0\n';
  });
  assert.equal(uidHasProcesses(10001), true); assert.equal(uidHasProcesses(10002), false);
  denied = true;
  assert.throws(() => uidHasProcesses(10001), /denied/);
});

test('常驻服务无 DAC_*；只有备份和文件恢复的一次性命令带对应能力', () => {
  const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(read('compose.yaml'), /DAC_(?:OVERRIDE|READ_SEARCH)/);
  const commands = ['backup.sh', 'restore.sh'].flatMap(file => read(`deploy/${file}`).split('\n').filter(line => line.startsWith('docker compose')));
  const elevated = commands.filter(line => line.includes('--cap-add'));
  assert.equal(elevated.length, 2);
  assert.match(elevated[0], /--cap-add DAC_READ_SEARCH agent node scripts\/backup.mjs/);
  assert.match(elevated[1], /--cap-add DAC_OVERRIDE agent node scripts\/restore.mjs --files/);
  assert.doesNotMatch(read('scripts/backup.mjs') + read('scripts/restore.mjs'), /repairRuntimeAccess/);
  assert.match(read('scripts/restore.mjs'), /'--numeric-owner', '--same-owner'/);
  assert.match(read('server/modules/data/migrations/012-runtime-migration.sql'), /ADD COLUMN IF NOT EXISTS migrated_at timestamptz/);
  assert.match(read('server/modules/data/database.mjs'), /012-runtime-migration.sql/);
  assert.doesNotMatch(read('server/modules/memory/index.mjs'), /fchown|fchmod/);
});

test('真实辅助进程：重复启动、记忆、日志和关闭不让服务访问用户内部文件', async t => {
  const { createRuntimes } = await import('../server/modules/runtimes/index.mjs');
  const { CodexConnection } = await import('../server/modules/codex/connection.mjs');
  const { AgentDefinition } = await import('../server/modules/agents/index.mjs');
  const root = fixture(t), uid = process.getuid();
  const record = { user_id: owner, uid, codex_home: path.join(root, '.data/users', owner, 'codex') };
  const paths = prepareDirectories(root, record, { isolated: false });
  fs.mkdirSync(path.join(paths.codexHome, 'memories'), { mode: 0o700 });
  fs.writeFileSync(path.join(paths.codexHome, 'memories/memory_summary.md'), 'private memory', { mode: 0o600 });
  fs.writeFileSync(path.join(paths.codexHome, '.sandbox_migration'), 'private', { mode: 0o600 });
  // 开发机只省略内核 uid/gid 切换，其他操作都走真实 worker；Linux 用 uid.integration 验证切换。
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => spawn(command, args, { ...options, uid: undefined, gid: undefined }));
  t.mock.method(fs, 'chownSync', () => {}); t.mock.method(fs, 'fchownSync', () => {});
  const internal = target => Object.values(paths).some(dir => String(target).startsWith(dir + path.sep));
  for (const name of ['lstatSync', 'statSync', 'openSync', 'readFileSync', 'readdirSync', 'realpathSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (target, ...args) => { assert.ok(!internal(target), `服务不能 ${name} ${target}`); return original(target, ...args); });
  }
  const config = { root, memory: { enabled: true, use: true, generate: false, minIdleHours: 1 }, launch: { args: [], env: {}, catalog: { models: [] } } };
  const source = path.join(root, 'package'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'SKILL.md'), 'private skill');
  const skill = { id: 'test', source, files: ['SKILL.md'], required: true };
  const agent = { workspacePath: path.join(root, 'workspace'), instructions: '', skills: [skill],
    activate: async function (_, skills) { this.availableSkills = skills; }, assertCurrent() {}, readSkill: AgentDefinition.prototype.readSkill };
  const store = { ensure: async () => record, migrateLegacy: async () => {}, assertEnabled: async () => {} };
  const tools = { configuration: () => ({}), verify: async () => {}, registry: { compatibilityVersion: 'test' } };
  const service = createRuntimes({ config, data: {}, agent, tools, store, isolated: true, redact: value => typeof value === 'string' ? value : JSON.stringify(value), log: () => {}, connection: options => {
    const rpc = new CodexConnection(options); rpc.open = async () => {};
    rpc.request = async method => method === 'skills/list' ? { data: [{ skills: [{ path: path.join(paths.codexHome, 'skills/test/SKILL.md'), name: 'test', enabled: true }] }] } : { config: { features: { memories: true }, memories: { use_memories: true, generate_memories: false, extract_model: null, consolidation_model: null, min_rollout_idle_hours: 1 } } };
    return rpc;
  } });
  try {
    for (let i = 0; i < 2; i++) {
      await service.pool.withOwner(owner, async value => {
        assert.equal((await value.memory.summary()).text, 'private memory');
        assert.equal((await value.agent.readSkill('test')).content, 'private skill');
        assert.equal((await value.memory.snapshot()).hasSummary, true);
        value.rpc.record('client', { method: 'test' }); value.rpc.record('server', { result: true });
      });
      await service.pool.serial(() => service.pool.remove(service.pool.entries.get(owner)));
    }
  } finally { await service.pool.close(); }
});
