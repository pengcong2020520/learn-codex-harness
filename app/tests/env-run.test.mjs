import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { accountArgs, envRunArgs } from '../scripts/quickstart-lib.mjs';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
function assertEnvRun(args, root, target = root) {
  assert.deepEqual(args.slice(0, 4), ['compose', 'run', '--rm', '--no-deps']);
  assert.deepEqual(args.flatMap((arg, i) => arg === '--cap-add' ? [args[i + 1]] : []), ['DAC_READ_SEARCH']);
  assert.equal(args[args.indexOf('-v') + 1], `${root}/.env:${target}/.env:ro`);
  assert.equal(args.includes('DAC_OVERRIDE'), false);
}
function fixture(t) {
  const root = fs.mkdtempSync('/tmp/app-env-run-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'deploy'));
  for (const name of ['configure', 'bootstrap', 'server-setup', 'restore', 'remote', 'topology', 'env-run']) {
    fs.copyFileSync(new URL(`../deploy/${name}.sh`, import.meta.url), path.join(root, 'deploy', `${name}.sh`));
  }
  // 仅隔离环境预检与外部状态；待验证的入口和调用脚本均执行真实源码。
  for (const name of ['check', 'enable-service', 'cluster-ready']) fs.writeFileSync(path.join(root, 'deploy', `${name}.sh`), 'exit 0\n');
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM test-image\n');
  fs.writeFileSync(path.join(root, '.env'), 'AGENT_CLUSTER_NODES=node-a\n', { mode: 0o600 });
  const executable = (name, body) => fs.writeFileSync(path.join(root, 'bin', name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  executable('docker', `
    const fs = require('node:fs'), args = process.argv.slice(2);
    fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
    if (args.includes('scripts/cluster-config.mjs') && args.at(-1) === 'nodes') process.stdout.write('node-a\\n');
    if (args.includes('scripts/accounts.mjs') && args.at(-1) === 'status') process.stdout.write('uninitialized\\n');
    if (args.includes('psql')) process.stdin.resume();
    if (args.some(arg => arg.endsWith('/.env:ro')) || args.at(-1) === 'prepare') process.exit(Number(process.env.ENV_RUN_EXIT || 0));
  `);
  executable('ssh', `const result = require('node:child_process').spawnSync('/bin/bash', ['-c', process.argv.at(-1)], { stdio: 'inherit' }); process.exit(result.status ?? 1);`);
  executable('flock', 'process.exit(0);');
  executable('gunzip', 'process.stdout.write("-- 测试数据库备份\\n");');
  const calls = path.join(root, 'calls');
  return { root, run(script, args = [], env = {}) {
    fs.writeFileSync(calls, '');
    const result = spawnSync('/bin/bash', [path.join(root, 'deploy', `${script}.sh`), ...args], {
      encoding: 'utf8', env: { PATH: `${root}/bin:${process.env.PATH}`, CALLS: calls, DEPLOY_HOST: 'fixture-host', APP_DIR: root, ...env },
    });
    return { ...result, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  } };
}

for (const [script, args, programs] of [
  ['configure', [], ['prepare', 'migrate']],
  ['configure', ['--config-only'], ['prepare']],
  ['bootstrap', [], ['migrate']],
  ['server-setup', [], ['prepare', 'scripts/cluster-migrate.mjs']],
  ['restore', ['2026-01-01T00-00-00-000Z', '--yes'], ['scripts/cluster-migrate.mjs']],
  ['remote', ['auth-init'], ['scripts/maintenance.mjs']],
  ...['add', 'passwd', 'disable', 'list'].map(command => ['remote', ['user', '--', command, ...(command === 'list' ? [] : ['bob'])], ['scripts/maintenance.mjs']]),
  ['env-run', ['-T', 'node-a', 'node', 'scripts/maintenance.mjs', 'accounts', 'status'], ['scripts/maintenance.mjs']],
]) test(`一次性入口：${script} ${args.join(' ')} 的每次配置读取都带只读挂载与 DAC_READ_SEARCH`, t => {
  const f = fixture(t), before = fs.statSync(path.join(f.root, '.env'));
  const result = f.run(script, args);
  assert.equal(result.status, 0, result.stderr);
  const calls = result.calls.filter(call => call.some(arg => arg.includes('/.env:')) || ['prepare', 'migrate'].includes(call.at(-1)));
  assert.deepEqual(calls.map(call => call.find(arg => /^scripts\//.test(arg)) || call.at(-1)), programs);
  for (const call of calls) {
    if (['prepare', 'migrate'].includes(call.at(-1))) {
      assert.deepEqual(call, ['compose', 'run', '--rm', '--no-deps', '-T', call.at(-1)]);
      continue;
    }
    assertEnvRun(call, f.root);
    assert.equal(call.includes('-T'), script !== 'remote');
    if (call.includes('scripts/cluster-migrate.mjs')) assert.equal(call[call.indexOf('--user') + 1], '0');
  }
  const after = fs.statSync(path.join(f.root, '.env'));
  assert.equal(after.mode & 0o777, 0o600);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});

test('一次性入口：Node 与 shell 参数一致，容器目标目录和含空格参数保持完整', t => {
  const f = fixture(t), args = ['-T', 'node-a', 'node', 'scripts/maintenance.mjs', 'accounts', 'list', '带空格参数'];
  const result = f.run('env-run', args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [envRunArgs(f.root, args)]);
  assertEnvRun(envRunArgs('/tmp/host app', args, { CONTAINER_APP_DIR: '/srv/container app' }), '/tmp/host app', '/srv/container app');
  for (const command of ['init', 'add', 'passwd', 'disable', 'list', 'status']) assertEnvRun(accountArgs(f.root, command), f.root);
});

test('一次性入口：失败保留退出码且配置脚本不继续迁移或重试', t => {
  const f = fixture(t);
  for (const [script, args] of [['env-run', ['-T', 'node-a', 'node', 'scripts/maintenance.mjs', 'accounts', 'status']], ['configure', []]]) {
    const result = f.run(script, args, { ENV_RUN_EXIT: '23' });
    assert.equal(result.status, 23);
    assert.equal(result.calls.filter(call => call.some(arg => arg.endsWith('/.env:ro')) || call.at(-1) === 'prepare').length, 1);
    assert.equal(result.calls.some(call => call.includes('scripts/cluster-migrate.mjs') || call.at(-1) === 'migrate'), false);
  }
});

test('一次性入口：宿主 .env 挂载集中在两个公共入口，本机入口直接交给 Compose', () => {
  const mounts = [];
  for (const directory of ['deploy', 'scripts']) {
    for (const file of fs.readdirSync(new URL(`../${directory}/`, import.meta.url))) {
      if (!/\.(sh|mjs)$/.test(file)) continue;
      const name = `${directory}/${file}`;
      if (/\.env:/.test(read(name))) mounts.push(name);
    }
  }
  assert.deepEqual(mounts.sort(), ['deploy/env-run.sh', 'scripts/quickstart-lib.mjs']);
  for (const file of ['scripts/setup.mjs', 'scripts/ctl.mjs', 'scripts/cluster-enable.mjs']) assert.doesNotMatch(read(file), /deploy\/configure.sh/);
  assert.match(read('scripts/deploy.mjs'), /bash deploy\/env-run.sh -T node-a node scripts\/maintenance.mjs accounts status/);
  for (const name of ['README.md', 'docs/isolation-acceptance.md']) assert.doesNotMatch(read(name), /\.env:/);
  assert.match(read('docs/isolation-acceptance.md'), /bash deploy\/env-run.sh node-a node scripts\/maintenance.mjs accounts/);
  assert.doesNotMatch(read('README.md'), /-v "?\$PWD\/\.env/);
  assert.match(read('README.md'), /npm run auth:init/);
  assert.match(read('README.md'), /npm run user:add/);
});

test('Compose 静态检查：长期服务能力集合和继承关系保持原样', () => {
  // 固定检查能力声明全文，新增到其他服务或共享锚点的能力也会被发现。
  for (const [file, expected] of [
    ['compose.yaml', ['cap_drop: [ALL]', 'cap_add: [SETUID, SETGID]', 'cap_drop: [ALL]', 'cap_add: [CHOWN, FOWNER, DAC_OVERRIDE]', 'cap_drop: [ALL]', 'cap_add: [FOWNER, DAC_READ_SEARCH]', 'cap_drop: [ALL]', 'cap_drop: [ALL]', 'cap_add: [SETUID, SETGID, CHOWN, FOWNER]']],
    ['deploy/remote.compose.yaml', ['cap_drop: [ALL]', 'cap_add: [SETUID,SETGID,CHOWN,FOWNER]']],
    ['deploy/two-host.compose.yaml', []],
    ['deploy/acceptance.compose.yaml', ['cap_drop: [ALL]', 'cap_add: [CHOWN,FOWNER,SETUID,SETGID]']],
  ]) {
    const source = read(file);
    assert.deepEqual(source.split('\n').filter(line => /cap_(?:add|drop):/.test(line)).map(line => line.trim()), expected, file);
    assert.doesNotMatch(source, /privileged:/);
    if (file !== 'compose.yaml') assert.doesNotMatch(source, /DAC_READ_SEARCH|DAC_OVERRIDE/);
  }
  const compose = read('compose.yaml');
  assert.match(compose, /node-a: &node[\s\S]*?cap_drop: \[ALL\]\n    cap_add: \[SETUID, SETGID, CHOWN, FOWNER\]/);
  for (const node of ['node-b', 'node-c']) assert.match(compose, new RegExp(`  ${node}:\\n    profiles: \\["cluster"\\]\\n    <<: \\*node`));
});

test('Compose 初始化：prepare 仅读环境，migrate 以只读挂载和 DAC_READ_SEARCH 读配置', () => {
  const source = read('compose.yaml');
  const prepare = source.split('  prepare:\n')[1].split('  migrate:\n')[0];
  const migrate = source.split('  migrate:\n')[1].split('  postgres:\n')[0];
  assert.match(prepare, /network_mode: none/);
  assert.doesNotMatch(prepare, /source: .*\.env|env_file:/);
  assert.match(read('scripts/compose-init.mjs'), /writeGatewayConfig\(root, env, \{ readEnv: false \}\)/);
  assert.match(migrate, /source: \.\/\.env\n        target: \$\{CONTAINER_APP_DIR\}\/\.env\n        read_only: true\n        bind: \{ create_host_path: false \}/);
  assert.match(migrate, /cap_add: \[FOWNER, DAC_READ_SEARCH\]/);
  for (const body of [prepare, migrate]) assert.match(body, /restart: "no"/);
});
