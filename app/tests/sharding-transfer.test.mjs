import { nodeAuth, authHeaders } from './fixtures/node-auth.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTarListing, transferPath, publishTree } from '../server/modules/sharding/transfer.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stderrCollector, subprocessFailure, STDERR_LIMIT } from '../server/modules/sharding/transfer-diagnostics.mjs';
import { errorSummary } from '../server/modules/data/diagnostics.mjs';
import { runtimeHome } from '../server/modules/runtimes/directories.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { Readable } from 'node:stream';

const uid = 10004, user = '00000000-0000-4000-8000-000000000017';
const entry = (owner, group, name = './history.txt', mode = '-rw-rw----') => `${mode} ${owner}/${group} 20 2026-01-01 00:00 ${name}\n`;

test('复制连续发布三次不保留旧目录；迁移默认保留；发布失败恢复旧副本', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'codex'), stage = path.join(root, 'stage');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'value'), 'old');
  for (let n = 1; n <= 3; n++) {
    fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, 'value'), String(n));
    await publishTree(stage, target, { keepPrevious: false });
    assert.equal(fs.readFileSync(path.join(target, 'value'), 'utf8'), String(n));
    assert.deepEqual(fs.readdirSync(root), ['codex']);
  }
  await assert.rejects(publishTree(stage, target, { keepPrevious: false }), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(path.join(target, 'value'), 'utf8'), '3');
  assert.deepEqual(fs.readdirSync(root), ['codex']);
  fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, 'value'), 'migration');
  await publishTree(stage, target);
  const previous = fs.readdirSync(root).find(name => name.startsWith('codex.before-move-'));
  assert.ok(previous); assert.equal(fs.readFileSync(path.join(root, previous, 'value'), 'utf8'), '3');
});

test('旧副本清理失败只记日志，仍确认新目录发布成功', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'codex'), stage = path.join(root, 'stage'), logs = [];
  fs.mkdirSync(target); fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, 'value'), 'new');
  await publishTree(stage, target, { keepPrevious: false,
    removePrevious: async () => { throw Object.assign(new Error('private content'), { code: 'EACCES' }); }, log: line => logs.push(line) });
  assert.equal(fs.readFileSync(path.join(target, 'value'), 'utf8'), 'new');
  assert.equal(logs.length, 1); assert.match(logs[0], /before-move-.*code=EACCES/); assert.doesNotMatch(logs[0], /private content/);
});

test('home 清理辅助仅清空指定旧副本，支持私有只读目录，不追随软链接', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-cleanup-worker-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = path.join(root, 'codex.before-move-' + user), privateDir = path.join(previous, 'private');
  const outside = path.join(root, 'keep'); fs.writeFileSync(outside, 'keep');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(privateDir, 'history'), 'private', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(privateDir, 'scratch-link')); fs.chmodSync(privateDir, 0o500);
  const worker = fileURLToPath(new URL('../server/modules/sharding/transfer-cleanup.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [worker, previous], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(previous), []);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  fs.rmdirSync(previous);
});

test('迁移属主矩阵：home 只接受用户；workspace 接受 root/用户和 1000/用户组', () => {
  for (const kind of ['home', 'workspace']) for (const owner of [0, uid, uid + 1]) for (const group of [0, 1000, uid, uid + 1]) {
    const allowed = [1000, uid].includes(group) && (owner === uid || kind === 'workspace' && owner === 0);
    if (allowed) assert.doesNotThrow(() => validateTarListing(entry(owner, group), uid, kind));
    else assert.throws(() => validateTarListing(entry(owner, group), uid, kind));
  }
  assert.throws(() => validateTarListing(entry(uid, uid), uid, 'other'));
});

test('两种目录均拒绝软/硬链接、特殊文件、控制字符、反斜线、越界和重复路径', () => {
  for (const kind of ['home', 'workspace']) {
    for (const mode of ['lrwxrwxrwx', 'hrw-------', 'prw-------', 'crw-------', 'brw-------', 'srw-------']) {
      assert.throws(() => validateTarListing(entry(uid, uid, './file', mode), uid, kind));
    }
    for (const name of ['./../escape', './x/../../escape', '/absolute', './a\u0001', './a\u007f', './a\nb', './a\\nb', './a\\b']) {
      assert.throws(() => validateTarListing(entry(uid, uid, name), uid, kind), name);
    }
    assert.throws(() => validateTarListing(entry(uid, uid, './a') + entry(uid, uid, '././a'), uid, kind));
  }
});

test('共享运行映射仅重定位合法 home 布局；两个节点的数据路径保持独立', () => {
  const record = { user_id: user, uid, codex_home: `/source/.data/users/${user}/codex` };
  assert.equal(transferPath('/target', record, 'home'), `/target/.data/users/${user}/codex`);
  assert.equal(transferPath('/target', record, 'workspace'), `/target/workspace/users/${user}`);
  assert.equal(runtimeHome('/target', { ...record, codex_home: '/source/.data/codex' }), '/target/.data/codex');
  for (const codex_home of ['/etc', 'relative/.data/codex', '/source/../source/.data/codex', `/source/.data/users/another/codex`, '/source/.data/codex/']) {
    assert.throws(() => runtimeHome('/target', { ...record, codex_home }));
  }
});

test('子进程诊断限制 2KB，保留阶段/退出码/路径与固定原因，不泄露任意正文', () => {
  const stderr = stderrCollector();
  stderr.append(Buffer.from('tar: ./private/history: Cannot open: Permission denied\nSECRET BODY\n'));
  for (let n = 0; n < 50; n++) stderr.append(Buffer.from('/' + 'a'.repeat(200) + '\n'));
  assert.equal(Buffer.byteLength(stderr.text), STDERR_LIMIT);
  for (const phase of ['export', 'list', 'validate', 'extract']) {
    const error = subprocessFailure(Object.assign(new Error('SECRET COMMAND'), { code: 2 }), { kind: 'home', phase, stderr: stderr.text });
    const summary = errorSummary(error, { nodeId: 'node-b' });
    assert.equal(summary.subprocess.exitCode, 2); assert.equal(summary.subprocess.phase, phase);
    assert.match(summary.subprocess.stderr, /\.\/private\/history/); assert.match(summary.subprocess.stderr, /Permission denied/);
    assert.ok(Buffer.byteLength(summary.subprocess.stderr) <= STDERR_LIMIT);
    assert.doesNotMatch(JSON.stringify(summary), /SECRET BODY|SECRET COMMAND/);
  }
});

test('迁移 HTTP 错误仅日志含子进程摘要，客户端不含 stderr/路径', async () => {
  const logs = [], failure = subprocessFailure(Object.assign(new Error('Command failed SECRET'), { code: 2 }),
    { kind: 'workspace', phase: 'extract', stderr: 'tar: /private/archive: Cannot open: Permission denied\nSECRET CONTENT' });
  const generation = { nodeId: 'node-b', log: line => logs.push(line) };
  const app = { config: { generation }, data: { pool: { query: async () => { throw failure; } } } };
  const runtime = { ...nodeAuth('node-b') };
  const handler = createShardedHandler({}, { app, isReady: () => true }, runtime, {});
  const request = Object.assign(Readable.from([]), { url: `/internal/transfer?operationId=${user}&user=${user}&kind=workspace`, method: 'PUT', headers: authHeaders('node-a') });
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await handler(request, response);
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.body, /private|stderr|SECRET|Permission/);
  const diagnostic = JSON.parse(logs[0].slice('[HTTP] '.length));
  assert.equal(diagnostic.subprocess.phase, 'extract');
  assert.match(diagnostic.subprocess.stderr, /\/private\/archive/);
  assert.doesNotMatch(logs[0], /SECRET/);
});
