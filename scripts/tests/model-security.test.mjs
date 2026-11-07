import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ROOT, stages, codexPath, stageHome, localAuthPath, linkAuth, linkState, classify, validateBaseUrl } from '../model-common.mjs';
import { handshake, runProcess, askTerminal } from '../model-io.mjs';
import { main as setup } from '../setup-model.mjs';
import { main as doctor } from '../doctor.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-security-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const stage of stages(ROOT)) {
    const dir = path.join(root, stage.relative);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ['.env.example', 'package.json']) fs.copyFileSync(path.join(stage.dir, file), path.join(dir, file));
    fs.mkdirSync(path.dirname(codexPath({ ...stage, dir })), { recursive: true });
    fs.writeFileSync(codexPath({ ...stage, dir }), 'fake CLI');
  }
  fs.mkdirSync(path.join(root, 'app/config'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'app/config/models.json'), path.join(root, 'app/config/models.json'));
  const home = path.join(root, 'home');
  const target = localAuthPath({}, home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'fake credential');
  const logs = [], calls = [];
  return { root, home, target, all: stages(root), env: {}, logs, calls, log: line => logs.push(line),
    run: async (cli, args) => { calls.push(args); return { code: 0, output: args[0] === '--version' ? 'codex-cli 1.2.3' : 'Logged in using ChatGPT' }; } };
}

for (const mode of ['handshake success', 'handshake timeout', 'login timeout']) {
  test(`R1 ${mode}: 返回时忽略 SIGTERM 的原生子进程已退出`, { skip: process.platform === 'win32' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tree-'));
    const pidFile = path.join(dir, 'native.pid');
    const binary = path.join(dir, 'native');
    let wrapper;
    t.after(() => {
      if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
      try { wrapper?.kill('SIGKILL'); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
    execFileSync('cc', [path.join(ROOT, 'scripts/tests/fixtures/stubborn-native.c'), '-o', binary]);
    const env = { ...process.env, TEST_NATIVE: binary, TEST_PID_FILE: pidFile, TEST_REPLY: mode === 'handshake success' ? 'yes' : 'no' };
    const spawnImpl = (_command, _args, options) => {
      wrapper = spawn(process.execPath, [path.join(ROOT, 'scripts/tests/fixtures/native-wrapper.mjs')], options);
      return wrapper;
    };
    if (mode === 'login timeout') {
      const result = await runProcess('mock', ['login'], { env, spawnImpl, inherit: true, timeoutMs: 5000 });
      assert.equal(result.timedOut, true);
      assert.equal(result.cleanupFailed, false);
    } else assert.equal(await handshake('mock', { env, spawnImpl, timeoutMs: 5000 }), mode === 'handshake success');
    assert.ok(fs.existsSync(pidFile), 'native process started before timeout');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'native child must be gone when API returns');
    assert.throws(() => process.kill(wrapper.pid, 0), { code: 'ESRCH' });
  });
}

for (const kind of ['symlink', 'self', 'hardlink', 'directory-alias']) {
  test(`R2 拒绝 ${kind} 凭证目标且不替换原文件`, t => {
    const f = fixture(t), stage = f.all.find(s => s.id === 's01');
    fs.mkdirSync(stageHome(stage), { recursive: true });
    const destination = path.join(stageHome(stage), 'auth.json');
    fs.writeFileSync(destination, 'original');
    let target = f.target;
    if (kind === 'symlink') {
      target = path.join(f.home, 'linked-auth.json'); fs.symlinkSync(f.target, target);
    } else if (kind === 'self') target = destination;
    else if (kind === 'hardlink') { fs.unlinkSync(target); fs.linkSync(destination, target); }
    else {
      const alias = path.join(f.root, 'alias'); fs.symlinkSync(stageHome(stage), alias); target = path.join(alias, 'auth.json');
    }
    assert.throws(() => linkAuth(stage, target));
    assert.equal(fs.lstatSync(destination).isFile(), true);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(stageHome(stage)), ['auth.json']);
  });
}

test('R3 Base URL 拒绝两种终点、凭证、查询、非回环 HTTP', () => {
  for (const value of ['https://example.com/v1/responses', 'https://example.com/v1/chat/completions', 'https://example.com/v1/chat/completions/', 'https://user:fake@example.com', 'https://example.com/?key=fake', 'http://example.com']) assert.ok(validateBaseUrl(value), value);
  for (const value of ['https://example.com/v1', 'http://localhost:42/v1', 'http://127.0.0.1:42', 'http://[::1]:42']) assert.equal(validateBaseUrl(value), null);
});

test('R3 --check 与 doctor 均拒绝阶段不接受的 URL', async t => {
  const f = fixture(t), stage = f.all.find(s => s.id === 's01');
  fs.writeFileSync(path.join(stage.dir, '.env'), 'CODEX_API_KEY=fake\nCODEX_MODEL=test\nCODEX_BASE_URL=https://example.com/v1/chat/completions\n');
  for (const command of [setup, doctor]) {
    f.logs.length = 0;
    assert.equal(await command(command === setup ? ['--check', '--stage', 's01'] : ['--stage', 's01'], f), 1);
    assert.match(f.logs.join('\n'), /chat\/completions/);
  }
});

for (const id of ['s11', 's12', 'app']) {
  test(`R4 ${id} 缺网关 Key 时始终提示路线 C、不检查登录链接`, async t => {
    const f = fixture(t), stage = f.all.find(s => s.id === id);
    for (const values of [{}, { CODEX_API_KEY: 'fake', CODEX_BASE_URL: 'https://example.com', CODEX_MODEL: 'test' }]) {
      const result = classify(values, false, stage);
      assert.equal(result.kind, 'gateway');
      assert.ok(result.missing.some(item => /AGENT_GATEWAY_KEY.*路线 C/.test(item)));
    }
    for (const command of [setup, doctor]) {
      f.logs.length = 0;
      assert.equal(await command(command === setup ? ['--check', '--stage', id] : ['--stage', id], f), 1);
      const output = f.logs.join('\n');
      assert.match(output, /AGENT_GATEWAY_KEY.*路线 C/);
      assert.doesNotMatch(output, /link-login|缺少链接|已有登录/);
    }
    assert.equal(f.calls.some(args => args[0] === 'login'), false);
  });
}

test('R5 指南明确 s00 为未配置规则的例外；--check 不要求 .env', async t => {
  const f = fixture(t);
  assert.equal(await setup(['--check', '--stage', 's00'], f), 0);
  assert.match(f.logs.join('\n'), /已有登录 \| 无/);
  const guide = fs.readFileSync(path.join(ROOT, 'stages/setup-models.md'), 'utf8');
  assert.match(guide, /s00[^\n]*例外[^\n]*本机登录[^\n]*CODEX_API_KEY/);
});

test('R6 自定义 Base URL 经真实隐藏输入读取，失败不回显也不写入', async t => {
  const f = fixture(t), replies = ['B', '0'];
  const invalid = 'https://user:fake-private-url-key@example.com';
  let terminal = '', urlOptions;
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = raw => { input.isRaw = raw; };
  const output = new Writable({ write(chunk, _, callback) { terminal += chunk; callback(); } });
  f.ask = async (prompt, options) => {
    if (!prompt.startsWith('Base URL')) return replies.shift();
    urlOptions = options;
    const answer = askTerminal(prompt, { ...options, input, output });
    input.emit('keypress', invalid, {}); input.emit('keypress', '\r', { name: 'return' });
    return answer;
  };
  assert.equal(await setup(['--stage', 's01'], f), 1);
  assert.equal(terminal.includes(invalid), false);
  assert.equal(terminal.includes('fake-private-url-key'), false);
  assert.equal(urlOptions?.secret, true);
  assert.equal(f.logs.join('\n').includes(invalid), false);
  assert.match(f.logs.join('\n'), /账号、密码/);
  assert.equal(fs.existsSync(path.join(f.all.find(s => s.id === 's01').dir, '.env')), false);
});

for (const mode of ['handshake', 'login']) {
  test(`R1 Windows ${mode}: 包装先 close 后仍等待 taskkill /t /f 完成`, async () => {
    let treeKilled = false, spawnOptions;
    const child = new EventEmitter(); child.pid = 54321;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _, callback) {
      if (JSON.parse(chunk.toString()).method === 'initialize') queueMicrotask(() => child.stdout.write('{"id":1,"result":{}}\n'));
      callback();
    } });
    const spawnImpl = (command, args, options) => {
      if (command !== 'taskkill') { spawnOptions = options; return child; }
      assert.deepEqual(args, ['/pid', '54321', '/t', '/f']);
      const killer = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      setTimeout(() => { treeKilled = true; killer.emit('close', 0); }, 50);
      return killer;
    };
    if (mode === 'handshake') assert.equal(await handshake('mock', { platform: 'win32', spawnImpl }), true);
    else {
      const result = await runProcess('mock', ['login'], { platform: 'win32', spawnImpl, inherit: true, timeoutMs: 5 });
      assert.equal(result.timedOut, true);
      assert.equal(result.cleanupFailed, false);
      assert.equal(spawnOptions.stdio, 'inherit');
    }
    assert.equal(treeKilled, true);
  });
}

test('R1 Windows taskkill 失败不得报告握手成功', async () => {
  const child = new EventEmitter(); child.pid = 54321;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _, callback) {
    if (JSON.parse(chunk.toString()).method === 'initialize') queueMicrotask(() => child.stdout.write('{"id":1,"result":{}}\n'));
    callback();
  } });
  child.kill = () => queueMicrotask(() => child.emit('close', 0));
  const spawnImpl = command => {
    if (command !== 'taskkill') return child;
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit('error', new Error('synthetic failure')));
    return killer;
  };
  assert.equal(await handshake('mock', { platform: 'win32', spawnImpl }), false);
});

test('R1 A 路线登录超时即使包装返回 0 也不得继续链接或写配置', async t => {
  const f = fixture(t), replies = ['A', 'yes'];
  f.ask = async () => replies.shift();
  f.run = async (_command, args, options) => {
    if (args[1] === 'status') return { code: 1, output: '' };
    assert.equal(options.inherit, true);
    return { code: 0, output: '', timedOut: true };
  };
  assert.equal(await setup(['--stage', 's01'], f), 1);
  assert.equal(fs.existsSync(path.join(f.all.find(s => s.id === 's01').dir, '.env')), false);
  assert.match(f.logs.join('\n'), /登录未完成/);
});

test('R2 已有阶段链接的目标若变成符号链接，A 路线不得继续写配置', async t => {
  const f = fixture(t), stage = f.all.find(s => s.id === 's01');
  linkAuth(stage, f.target);
  const original = f.target + '.original';
  fs.renameSync(f.target, original); fs.symlinkSync(original, f.target);
  assert.notEqual(linkState(stage, f.target), '链接正确');
  f.ask = async () => 'A';
  assert.equal(await setup(['--stage', 's01'], f), 1);
  assert.equal(fs.existsSync(path.join(stage.dir, '.env')), false);
  assert.equal(fs.readFileSync(original, 'utf8'), 'fake credential');
});
