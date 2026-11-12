import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { exportTree, importTree } from '../server/modules/sharding/transfer.mjs';
import { prepareDirectories } from '../server/modules/runtimes/directories.mjs';
import { readAsUser } from '../server/modules/runtimes/user-files.mjs';
// No SSH or new library: exercise the real system tar with s14 uid ownership.
test('真实 Linux uid/tar：home 私有历史与 tmp、服务 workspace、数值属主、拒绝链接', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0, timeout: 30000,
}, async t => {
  assert.equal(process.getgid(), 1000);
  const roots = ['source', 'target'].map(label => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-transfer-' + label + '-'));
    fs.chmodSync(root, 0o755); return root;
  });
  t.after(() => {
    const allow = dir => {
      if (!fs.lstatSync(dir).isDirectory()) return;
      fs.chownSync(dir, 0, 1000); fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) allow(path.join(dir, name));
    };
    for (const root of roots) { allow(root); fs.rmSync(root, { recursive: true, force: true }); }
  });
  const id = randomUUID(), uid = 10017;
  // One shared DB record, two independent node roots.
  const record = { user_id: id, uid, codex_home: path.join(roots[0], '.data/users', id, 'codex') };
  const dirs = roots.map(root => prepareDirectories(root, record, { isolated: true }));
  const setup = spawnSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path'),h=process.argv[1];
    fs.mkdirSync(p.join(h,'private'),{mode:0o700});fs.chmodSync(p.join(h,'private'),0o700);
    fs.writeFileSync(p.join(h,'private/history.txt'),'完整历史与记忆',{mode:0o600});
    fs.chownSync(p.join(h,'private/history.txt'),process.getuid(),process.getgid());
    fs.mkdirSync(p.join(h,'tmp/arg0/codex-fixture'),{recursive:true});
    fs.symlinkSync('/bin/true',p.join(h,'tmp/arg0/codex-fixture/apply_patch'));`, dirs[0].codexHome],
    { uid, gid: uid, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr || setup.error?.message);
  const workspace = path.join(dirs[0].workspaceDir, 'history.txt');
  fs.writeFileSync(workspace, '完整历史与记忆', { mode: 0o660 }); fs.chownSync(workspace, 0, 1000); fs.chmodSync(workspace, 0o660);
  const userFile = path.join(dirs[0].workspaceDir, 'user.txt');
  fs.writeFileSync(userFile, 'user workspace', { mode: 0o660 }); fs.chownSync(userFile, uid, 1000); fs.chmodSync(userFile, 0o3660);
  const groupDir = path.join(dirs[0].workspaceDir, 'group'); fs.mkdirSync(groupDir); fs.chownSync(groupDir, 0, 1000); fs.chmodSync(groupDir, 0o3770);
  for (const kind of ['home', 'workspace']) {
    const transfer = exportTree(roots[0], record, kind);
    try { await importTree(roots[1], record, kind, transfer.stream); await transfer.done; }
    finally { await transfer.stop(); }
  }
  const copy = path.join(dirs[1].codexHome, 'private/history.txt');
  assert.equal((await readAsUser(uid, copy, { maxBytes: 128 })).toString(), '完整历史与记忆');
  const check = spawnSync(process.execPath, ['-e', `const s=require('node:fs').statSync(process.argv[1]);console.log(JSON.stringify([s.uid,s.gid,s.mode&511]));`, copy], { uid, gid: uid, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), [uid, uid, 0o600]);
  assert.equal(fs.existsSync(path.join(dirs[1].codexHome, 'tmp')), false);
  for (const [name, owner, content] of [['history.txt', 0, '完整历史与记忆'], ['user.txt', uid, 'user workspace']]) {
    const target = path.join(dirs[1].workspaceDir, name), stat = fs.statSync(target);
    assert.equal(fs.readFileSync(target, 'utf8'), content);
    assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777], [owner, 1000, 0o660]);
  }
  assert.equal(fs.statSync(path.join(dirs[1].workspaceDir, 'user.txt')).mode & 0o7000, 0);
  assert.equal(fs.statSync(path.join(dirs[1].workspaceDir, 'group')).mode & 0o7777, 0o2770);
  const suid = path.join(dirs[0].workspaceDir, 'suid'); fs.writeFileSync(suid, 'not executable'); fs.chownSync(suid, 0, 1000); fs.chmodSync(suid, 0o4660);
  const forbidden = exportTree(roots[0], record, 'workspace');
  try { await assert.rejects(importTree(roots[1], record, 'workspace', forbidden.stream), error => error.subprocessDiagnostic.phase === 'validate'); await forbidden.done; }
  finally { await forbidden.stop(); fs.unlinkSync(suid); }
  const limited=exportTree(roots[0],record,'workspace',{maxBytes:32});limited.stream.resume();
  try { await assert.rejects(limited.done,{code:'TRANSFER_TOO_LARGE'}); } finally { await limited.stop(); }
  const oldLimit = process.env.AGENT_TRANSFER_MAX_BYTES; process.env.AGENT_TRANSFER_MAX_BYTES = '32';
  try {
    const input = Readable.from([Buffer.alloc(32), Buffer.alloc(1)]);
    await assert.rejects(importTree(roots[1], record, 'workspace', input), { status: 413 });
    assert.equal(input.destroyed, true);
    assert.deepEqual(fs.readdirSync(path.join(roots[1], '.data/transfers')), []);
    assert.equal(fs.readdirSync(path.dirname(dirs[1].workspaceDir)).some(name => name.startsWith('.move-')), false);
  } finally { if (oldLimit === undefined) delete process.env.AGENT_TRANSFER_MAX_BYTES; else process.env.AGENT_TRANSFER_MAX_BYTES = oldLimit; }
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 0n, bsize: 4096n }));
  await assert.rejects(importTree(roots[1], record, 'workspace', Readable.from([])), { status: 507 });
  t.mock.restoreAll();
  for (const [kind, dir] of [['home', dirs[0].codexHome], ['workspace', dirs[0].workspaceDir]]) {
    const link = path.join(dir, 'forbidden-link'); fs.symlinkSync('/etc/passwd', link);
    const transfer = exportTree(roots[0], record, kind); transfer.stream.resume();
    await assert.rejects(transfer.done, error => {
      assert.equal(error.subprocessDiagnostic.phase, 'export');
      assert.equal(error.subprocessDiagnostic.kind, kind);
      assert.match(error.subprocessDiagnostic.stderr, /迁移拒绝链接/); return true;
    });
    await transfer.stop(); fs.unlinkSync(link);
  }
  await assert.rejects(importTree(roots[1], record, 'workspace', Readable.from(['invalid tar archive']),
    () => assert.fail('invalid archive must never publish')), error => {
    assert.equal(error.subprocessDiagnostic.phase, 'list');
    assert.equal(error.subprocessDiagnostic.kind, 'workspace');
    assert.ok(error.subprocessDiagnostic.exitCode > 0);
    assert.match(error.subprocessDiagnostic.stderr, /tar archive|Unexpected EOF/); return true;
  });
  assert.equal(fs.readFileSync(path.join(dirs[1].workspaceDir, 'history.txt'), 'utf8'), '完整历史与记忆');
});
