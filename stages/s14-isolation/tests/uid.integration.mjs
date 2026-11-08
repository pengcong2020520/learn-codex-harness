// Linux 且能切换 uid/gid 时运行；普通开发机明确跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userSpawn } from '../server/modules/codex/launch.mjs';

test('uid/gid 子进程的 /proc/self/status Groups 为空或仅自身组，绝不含 1000', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 ? '需要可切换 uid/gid 的 Linux 环境' : false,
}, t => {
  const uid = 10001, gid = 10001;
  const launch = userSpawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), status: fs.readFileSync('/proc/self/status', 'utf8') }));
  `], { uid, gid, isolated: true });
  const child = spawnSync(launch.command, launch.args, { ...launch.options, cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  if (child.error?.code === 'EPERM') return t.skip('当前 Linux 环境不允许切换 uid/gid');
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.uid, uid); assert.equal(result.gid, gid);
  const line = result.status.split('\n').find(line => line.startsWith('Groups:'));
  assert.ok(line, '/proc/self/status 必须提供 Groups');
  const groups = line.slice('Groups:'.length).trim().split(/\s+/).filter(Boolean).map(Number);
  assert.ok(!groups.includes(1000));
  assert.ok(groups.every(group => group === gid), `意外补充组：${groups}`);
});
