// Run only outside the restricted sandbox, in the compose agent with its configured capabilities.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { prepareDirectories, secureDirectory, migrateLegacyTree } from '../server/modules/runtimes/directories.mjs';
import { userSpawn, userEnvironment, signalUserProcess } from '../server/modules/codex/launch.mjs';
import { MemoryService } from '../server/modules/memory/index.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.getgid() !== 1000)
  throw new Error('必须在 compose agent 的 Linux 0:1000 环境运行；本测试会真实切换 uid/gid。');
test('Linux 一次性迁移: 真实 chown 跳过树外软链接与 socket，硬链接仍拒绝', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's17-links-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex'), outside = path.join(root, 'outside');
  const arg0 = path.join(home, 'tmp/arg0/codex-arg0-test');
  fs.mkdirSync(arg0, { recursive: true }); fs.mkdirSync(outside);
  const binary = path.join(outside, 'codex'), auth = path.join(outside, 'auth.json');
  fs.writeFileSync(binary, 'external executable', { mode: 0o755 });
  fs.writeFileSync(auth, '{}', { mode: 0o600 });
  for (const name of ['apply_patch', 'applypatch', 'codex-linux-sandbox', 'codex-execve-wrapper']) fs.symlinkSync(binary, path.join(arg0, name));
  fs.symlinkSync(auth, path.join(home, 'auth.json'));
  fs.symlinkSync(outside, path.join(home, 'external-dir'));
  const socket = path.join(home, 'runtime.sock'), server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  try {
    const metadata = target => { const { uid, gid, mode } = fs.lstatSync(target); return { uid, gid, mode }; };
    const targets = [outside, binary, auth, socket], before = targets.map(metadata);
    assert.ok(fs.lstatSync(socket).isSocket());
    const native = path.join(home, 'native'); fs.writeFileSync(native, 'session', { mode: 0o600 });
    migrateLegacyTree(home, 10001); secureDirectory(home, 10001, true);
    assert.deepEqual(targets.map(metadata), before);
    assert.equal(fs.statSync(native).uid, 10001);
    assert.equal(fs.statSync(native).gid, 1000);
    assert.equal(fs.statSync(native).mode & 0o7777, 0o660);
    fs.linkSync(auth, path.join(home, 'hard'));
    assert.throws(() => migrateLegacyTree(home, 10001), /硬链接/);
    assert.deepEqual(targets.map(metadata), before);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('Linux uid: 最小 capabilities、私有组、跨用户不可读、2770、umask、环境白名单', async t => {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const caps = BigInt('0x' + status.match(/^CapEff:\s+(\w+)/m)[1]);
  const expected = [0n, 3n, 6n, 7n].reduce((mask, bit) => mask | (1n << bit), 0n);
  assert.equal(caps, expected); assert.match(status, /^NoNewPrivs:\s+1$/m);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's17-uid-')); fs.chmodSync(root, 0o755);
  t.after(() => {
    for (const [index, dirs] of paths.entries()) {
      const result = spawnSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path');for(const dir of process.argv.slice(1))for(const name of fs.readdirSync(dir))fs.rmSync(p.join(dir,name),{recursive:true,force:true});`, ...Object.values(dirs)], { uid: 10001 + index, gid: 10001 + index, cwd: '/tmp', encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const owners = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const paths = owners.map((owner, index) => {
    const record = { user_id: owner, uid: 10001 + index, codex_home: index ? path.join(root, '.data/users', owner, 'codex') : path.join(root, '.data/codex') };
    const dirs = prepareDirectories(root, record, { isolated: true });
    fs.writeFileSync(path.join(dirs.codexHome, 'marker'), owner); migrateLegacyTree(dirs.codexHome, record.uid);
    for (const target of Object.values(dirs)) {
      const stat = fs.statSync(target); assert.equal(stat.uid, record.uid); assert.equal(stat.gid, 1000); assert.equal(stat.mode & 0o7777, 0o2770);
    }
    return dirs;
  });
  for (const [index, owner] of owners.entries()) {
    const code = `const fs=require('node:fs');
      let cross; try { fs.readFileSync(process.argv[1]); cross='LEAK'; } catch(e) { cross=e.code; }
      fs.writeFileSync('umask-file','fixture'); fs.mkdirSync('umask-dir');
      fs.mkdirSync(process.env.CODEX_HOME+'/memories',{mode:0o700});
      fs.writeFileSync(process.env.CODEX_HOME+'/memories/memory_summary.md','private-summary',{mode:0o600});
      console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),status:fs.readFileSync('/proc/self/status','utf8'),env:process.env,
        own:fs.readFileSync(process.env.CODEX_HOME+'/marker','utf8'),cross,
        fileMode:fs.statSync('umask-file').mode&0o777,dirMode:fs.statSync('umask-dir').mode&0o7777}));`;
    const launch = userSpawn(process.execPath, ['-e', code, path.join(paths[1 - index].codexHome, 'marker')], { isolated: true, uid: 10001 + index, gid: 10001 + index });
    const env = userEnvironment({ PATH: process.env.PATH, LANG: 'C.UTF-8', CODEX_API_KEY: 'gateway-fixture', CODEX_BASE_URL: 'https://example.com/v1',
      DATABASE_URL: 'must-not-leak', REDIS_URL: 'must-not-leak', OPENAI_API_KEY: 'must-not-leak', NODE_OPTIONS: 'must-not-leak' }, paths[index].codexHome);
    const child = spawnSync(launch.command, launch.args, { ...launch.options, cwd: paths[index].workspaceDir, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const result = JSON.parse(child.stdout);
    assert.equal(result.uid, 10001 + index); assert.equal(result.gid, 10001 + index); assert.ok(!result.groups.includes(1000));
    const groups = result.status.split('\n').find(line => line.startsWith('Groups:')).slice(7).trim().split(/\s+/).filter(Boolean).map(Number);
    assert.ok(!groups.includes(1000)); assert.ok(groups.every(group => group === 10001 + index));
    assert.equal(result.own, owner); assert.equal(result.cross, 'EACCES'); assert.equal(result.fileMode, 0o660); assert.equal(result.dirMode, 0o2770);
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.equal(result.env[key], undefined);
    assert.equal(result.env.HOME, paths[index].codexHome);
    const memory = new MemoryService({ config: { root, codexHome: paths[index].codexHome, runtimeUid: 10001 + index }, redact: String }); memory.effective = { enabled: true };
    assert.equal((await memory.summary()).text, 'private-summary');
  }
  console.log('PASS：uid/gid 10001、10002；无共享补充组；跨用户 EACCES；目录 2770；umask 与白名单生效。');
});


test('Linux termination: 无 KILL capability 仍能通过同 uid 发送器关闭用户进程', async t => {
  const runtime = { uid: 10001, gid: 10001, isolated: true, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } };
  const command = userSpawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], runtime);
  const child = spawn(command.command, command.args, { ...command.options, env: runtime.env, stdio: ['ignore', 'pipe', 'ignore'] });
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) await signalUserProcess(child.pid, 'SIGKILL', runtime); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await signalUserProcess(child.pid, 'SIGTERM', runtime);
  assert.equal((await ended).signal, 'SIGTERM');
});
