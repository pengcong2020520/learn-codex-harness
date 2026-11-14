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

// 在常驻 agent 的最小能力集下复现 0600：不要求 DAC_*，也不修复用户内部权限。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { prepareDirectories } from '../server/modules/runtimes/directories.mjs';
import { readAsUser } from '../server/modules/runtimes/user-files.mjs';
import { createRuntimes } from '../server/modules/runtimes/index.mjs';

const linuxUid = process.platform === 'linux' && process.getuid?.() === 0;
test('0600：服务启动成功，10001 可以读取，10002 被拒绝；重启不修改用户文件', { skip: !linuxUid && '需要可切换 uid/gid 的 Linux 环境' }, async t => {
  const probe = spawnSync(process.execPath, ['-e', ''], { uid: 10001, gid: 10001, cwd: '/tmp' });
  if (probe.error?.code === 'EPERM') return t.skip('当前 Linux 环境不允许切换 uid/gid');
  assert.equal(probe.status, 0, probe.error?.message);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-private-')); fs.chmodSync(root, 0o755);
  const owner = '11111111-1111-4111-8111-111111111111';
  const record = { user_id: owner, uid: 10001, codex_home: path.join(root, '.data/users', owner, 'codex'), migrated_at: null };
  const paths = prepareDirectories(root, record, { isolated: true });
  t.after(() => {
    for (const directory of Object.values(paths)) {
      const result = spawnSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path');for(const name of fs.readdirSync(process.argv[1]))fs.rmSync(p.join(process.argv[1],name),{recursive:true,force:true});`, directory], { uid: 10001, gid: 10001, cwd: '/tmp', encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const native = path.join(paths.codexHome, '.sandbox_migration');
  const setup = spawnSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path');
    for(const dir of process.argv.slice(1)) fs.writeFileSync(p.join(dir,'.sandbox_migration'),'private',{mode:0o600});
    fs.mkdirSync(p.join(process.argv[1],'memories'),{mode:0o700});
    fs.writeFileSync(p.join(process.argv[1],'memories/memory_summary.md'),'private memory',{mode:0o600});`, ...Object.values(paths)], { uid: 10001, gid: 10001, cwd: '/tmp', encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);
  assert.doesNotThrow(() => prepareDirectories(root, record, { isolated: true }));
  assert.equal(fs.statSync(native).mode & 0o777, 0o600);
  assert.equal((await readAsUser(10001, native, { maxBytes: 64 })).toString(), 'private');
  await assert.rejects(readAsUser(10002, native, { maxBytes: 64 }), error => error.code === 'EACCES');
  const caps = BigInt('0x' + fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s+(\w+)/m)[1]);
  if (!(caps & 6n)) assert.throws(() => fs.readFileSync(native), { code: 'EACCES' });

  // 经过真实 runtime 组装、配置/Skill 安装、记忆读取和维护；仅替换模型 RPC。
  const config = { root, memory: { enabled: true, use: true, generate: false, minIdleHours: 1 }, launch: { args: [], env: {}, catalog: { models: [] } } };
  const agent = { workspacePath: path.join(root, 'workspace'), instructions: '', skills: [], activate: async () => {} };
  const store = { ensure: async () => record, migrateLegacy: async () => {}, assertEnabled: async () => {} };
  const tools = { configuration: () => ({}), verify: async () => {}, registry: { compatibilityVersion: 'test' } };
  const service = createRuntimes({ config, data: {}, agent, tools, store, isolated: true, redact: String, log: () => {}, connection: () => {
    const rpc = new EventEmitter(); rpc.open = async () => {}; rpc.close = async () => {};
    rpc.request = async method => method === 'skills/list' ? { data: [] } : { config: { features: { memories: true }, memories: { use_memories: true, generate_memories: false, extract_model: null, consolidation_model: null, min_rollout_idle_hours: 1 } } };
    return rpc;
  } });
  try {
    for (let i = 0; i < 2; i++) {
      await service.pool.withOwner(owner, async value => { assert.equal((await value.memory.summary()).text, 'private memory'); });
      await service.pool.serial(() => service.pool.remove(service.pool.entries.get(owner)));
    }
  } finally { await service.pool.close(); }
  assert.equal(fs.statSync(native).uid, 10001); assert.equal(fs.statSync(native).mode & 0o777, 0o600);
});

import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';

test('预览文件：真实 uid 属主保持不变，拒绝跨用户路径及符号链接', { skip: !linuxUid && '需要可切换 uid/gid 的 Linux 环境' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-uid-')); fs.chmodSync(root, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owners = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (const [index, owner] of owners.entries()) {
    const uid = 10001 + index;
    const paths = prepareDirectories(root, { user_id: owner, uid, codex_home: path.join(root, '.data/users', owner, 'codex') }, { isolated: true });
    const child = userSpawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      fs.mkdirSync('outputs', { mode: 0o2770 });
      fs.writeFileSync('outputs/page.html', '<html>用户产物</html>', { mode: 0o660 });
    `], { uid, gid: uid, isolated: true });
    const seeded = spawnSync(child.command, child.args, { ...child.options, cwd: paths.workspaceDir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
  }
  const files = createUserFileTools(root, { workspaceDir: path.join(root, 'workspace'), sources: [{ id: 'output', locator: 'outputs', actions: ['read'] }] });
  for (const [index, owner] of owners.entries()) runOwner(owner, () => {
    const own = path.join(root, 'workspace/users', owner, 'outputs/page.html'), before = fs.statSync(own);
    assert.equal(before.uid, 10001 + index);
    assert.equal(files.read_preview({ path: 'outputs/page.html' }).content.toString(), '<html>用户产物</html>');
    const other = path.join(root, 'workspace/users', owners[1 - index], 'outputs/page.html');
    fs.symlinkSync(other, path.join(files.workspace, 'outputs/link.html'));
    assert.throws(() => files.read_preview({ path: 'outputs/link.html' }), /符号链接/);
    assert.throws(() => files.read_preview({ path: `outputs/../../${owners[1 - index]}/outputs/page.html` }), /上级目录/);
    assert.equal(fs.statSync(own).uid, before.uid); assert.equal(fs.statSync(own).mode, before.mode);
  });
});

test('上传文件：真实用户 uid、共享组和权限与生产写入一致，其他 uid 无法读取', { skip: !linuxUid && '需要可切换 uid/gid 的 Linux 环境' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-uid-')); fs.chmodSync(root, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = '11111111-1111-4111-8111-111111111111', uid = 10001;
  prepareDirectories(root, { user_id: owner, uid, codex_home: path.join(root, '.data/users', owner, 'codex') }, { isolated: true });
  const files = createUserFileTools(root, { workspaceDir: path.join(root, 'workspace'),
    sources: [{ id: 'input', locator: 'inputs', actions: ['read'], readOnly: true }], outputs: { directory: 'outputs', formats: ['md'] } });
  const file = runOwner(owner, () => {
    files.write_file({ path: 'outputs/normal.md', content: '模型产物' });
    files.write_upload({ path: 'inputs/uploads/需求.md', content: Buffer.from('用户 PRD') });
    const target = path.join(files.workspace, 'inputs/uploads/需求.md');
    const normal = fs.statSync(path.join(files.workspace, 'outputs/normal.md')), uploaded = fs.statSync(target);
    assert.equal(uploaded.uid, uid); assert.equal(uploaded.gid, 1000);
    assert.equal(uploaded.mode & 0o777, normal.mode & 0o777);
    assert.equal(uploaded.uid, normal.uid); assert.equal(uploaded.gid, normal.gid);
    return target;
  });
  assert.equal((await readAsUser(uid, file, { maxBytes: 256 * 1024 })).toString(), '用户 PRD');
  await assert.rejects(readAsUser(10002, file, { maxBytes: 256 * 1024 }), error => error.code === 'EACCES');
});
