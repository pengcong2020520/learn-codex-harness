// Linux offline test of the real flock lifetime; rsync is a deliberately blocking fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
const hasFlock = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;
test('下载锁：真实 flock 在整个发送期间拒绝下载、备份与恢复', { skip: !hasFlock }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's12-download-'));
  fs.mkdirSync(path.join(root, 'deploy')); fs.mkdirSync(path.join(root, 'bin'));
  for (const file of ['download-rsync.sh', 'backup.sh', 'restore.sh']) fs.copyFileSync(new URL(`../deploy/${file}`, import.meta.url), path.join(root, 'deploy', file));
  fs.writeFileSync(path.join(root, 'bin/rsync'), '#!/bin/sh\ntouch backups/started\nwhile [ ! -f backups/release ]; do sleep 0.1; done\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}` };
  const first = spawn('bash', ['deploy/download-rsync.sh'], { cwd: root, env });
  const ended = new Promise(resolve => first.once('close', resolve));
  t.after(async () => { fs.writeFileSync(path.join(root, 'backups/release'), ''); await ended; fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(root, 'backups/started')); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(root, 'backups/started')));
  const second = spawnSync('bash', ['deploy/download-rsync.sh'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(second.status, 75); assert.match(second.stderr, /已有下载/);
  for (const [file, ...args] of [['backup.sh'], ['restore.sh', '2026-01-01T00-00-00-000Z', '--yes']]) {
    const blocked = spawnSync('bash', [`deploy/${file}`, ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(blocked.status, 75); assert.match(blocked.stderr, /正在进行/);
  }
  fs.writeFileSync(path.join(root, 'backups/release'), '');
  assert.equal(await ended, 0);
  const next = spawnSync('bash', ['deploy/download-rsync.sh'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(next.status, 0, next.stderr);
  assert.ok(fs.existsSync(path.join(root, 'backups/.download.lock')));
});
