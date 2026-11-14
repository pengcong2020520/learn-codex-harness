// 在可切换 uid/gid 的 Linux 容器内单独运行，不连接服务或读取真实配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useAgent } from '../scripts/agent-use.mjs';

function fixture(t) {
  assert.equal(process.platform, 'linux', '请在 Linux 容器内运行此集成测试');
  assert.equal(process.getuid(), 0, '容器测试进程需要能切换 uid/gid');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-use-uid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chownSync(root, 10001, 10001); fs.chmodSync(root, 0o755);
  for (const dir of ['agents', 'config']) fs.cpSync(new URL(`../${dir}`, import.meta.url), path.join(root, dir), { recursive: true });
  const file = path.join(root, '.env');
  fs.writeFileSync(file, 'PRIVATE=fixture-private-content\nAGENT_DEFINITION=old-selection\n', { mode: 0o600 });
  fs.chownSync(file, 10001, 10001);
  return { root, file };
}

test('agent:use Linux 特权进程原子替换后保留文件 uid/gid 与 0600', t => {
  const { root, file } = fixture(t), before = fs.statSync(file);
  useAgent('writing', { root, log() {} });
  const after = fs.statSync(file);
  assert.equal(after.uid, 10001); assert.equal(after.gid, 10001);
  assert.equal(after.mode & 0o777, 0o600); assert.notEqual(after.ino, before.ino);
  assert.equal(fs.readFileSync(file, 'utf8'), "PRIVATE=fixture-private-content\nAGENT_DEFINITION='agents/writing/agent.json'\n");
});

test('agent:use Linux 同 uid 可切换，其他 uid 被拒绝且不改变配置', t => {
  const { root, file } = fixture(t);
  const source = `import { useAgent } from ${JSON.stringify(new URL('../scripts/agent-use.mjs', import.meta.url).href)};
    try { useAgent('writing', { root: process.argv[1] }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const run = uid => spawnSync(process.execPath, ['--input-type=module', '-e', source, root], {
    uid, gid: uid, cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  const allowed = run(10001);
  assert.equal(allowed.status, 0, allowed.stderr);
  const before = fs.readFileSync(file), stat = fs.statSync(file), denied = run(10002);
  assert.equal(denied.status, 1, denied.stderr);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).ino, stat.ino);
  assert.equal(stat.uid, 10001); assert.equal(stat.gid, 10001); assert.equal(stat.mode & 0o777, 0o600);
  for (const result of [allowed, denied]) assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-content|old-selection|agents\/writing\/agent.json/);
});
