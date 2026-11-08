import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = fs.mkdtempSync('/tmp/s15-deploy-auth-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'deploy'));
  for (const name of ['server-setup.sh', 'remote.sh']) {
    fs.copyFileSync(new URL(`../deploy/${name}`, import.meta.url), path.join(root, 'deploy', name));
  }
  const executable = (name, source) => fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/bash\n${source}\n`, { mode: 0o755 });
  executable('bash', 'echo "bash $*" >> "$CALLS"'); // check/configure/enable-service do not touch the host.
  executable('ssh', 'echo "ssh $*" >> "$CALLS"\n/bin/bash -c "${@: -1}"');
  executable('docker', `echo "docker $*" >> "$CALLS"
case "$*" in
 *'node scripts/accounts.mjs status') echo "\${ACCOUNT_STATUS:-uninitialized}"; exit "\${STATUS_EXIT:-0}" ;;
 *'npm run auth:init') exit "\${INIT_EXIT:-0}" ;;
 *'node deploy/ready.mjs') echo '{"status":"ready"}' ;;
esac`);
  const calls = path.join(root, 'calls');
  return {
    run(script, args = [], env = {}) {
      fs.writeFileSync(calls, '');
      const result = spawnSync('/bin/bash', [path.join(root, 'deploy', script), ...args], {
        encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CALLS: calls,
          DEPLOY_HOST: 'fixture-host', APP_DIR: root, ...env },
      });
      return { ...result, calls: fs.readFileSync(calls, 'utf8') };
    },
  };
}

test('deploy 执行：首次未初始化成功退出，不启动 agent 或注册 systemd', t => {
  const result = fixture(t).run('server-setup.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /账号尚未初始化：运行 DEPLOY_HOST=fixture-host bash deploy\/remote.sh auth-init/);
  assert.match(result.calls, /up -d --wait postgres redis gateway/);
  assert.match(result.calls, /run --rm --no-deps -T agent npm run -s data:migrate/);
  assert.doesNotMatch(result.calls, /up[^\n]* agent|enable-service|ready.mjs/);
});
test('deploy 执行：已初始化启动 agent 并检查 ready；状态查询错误不能误判成功', t => {
  const f = fixture(t);
  const initialized = f.run('server-setup.sh', [], { ACCOUNT_STATUS: 'initialized' });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.calls, /up -d --wait --force-recreate agent/);
  assert.match(initialized.stdout, /"status":"ready"/);
  for (const env of [{ STATUS_EXIT: '1' }, { ACCOUNT_STATUS: 'unexpected' }]) {
    const failed = f.run('server-setup.sh', [], env);
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.calls, /up[^\n]* agent|enable-service|ready.mjs/);
  }
});
test('remote auth-init：保留 TTY；成功及重复初始化启动 agent，其他错误阻止启动', t => {
  const f = fixture(t);
  for (const code of [0, 3, 1, 130]) {
    const result = f.run('remote.sh', ['auth-init'], { INIT_EXIT: String(code) });
    assert.match(result.calls, /ssh -t fixture-host .*docker compose run --rm --no-deps agent npm run auth:init/);
    if (code === 0 || code === 3) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.calls, /docker compose up -d --wait agent/);
      assert.match(result.stdout, /"status":"ready"/);
    } else {
      assert.equal(result.status, code);
      assert.doesNotMatch(result.calls, /docker compose up/);
    }
  }
});
test('remote user：转发四个子命令，拒绝非法名称和额外参数，拒绝前不调用 SSH', t => {
  const f = fixture(t);
  for (const command of ['add', 'passwd', 'disable', 'list']) {
    const args = ['user', '--', command, ...(command === 'list' ? [] : ['bob_1.test-name'])];
    const result = f.run('remote.sh', args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, new RegExp(`ssh -t fixture-host .*npm run user:${command}`));
  }
  for (const name of ['', 'Alice', 'two words', "bob'; echo injected", '$(id)', 'a'.repeat(65)]) {
    const result = f.run('remote.sh', ['user', '--', 'add', name]);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
  }
  for (const args of [['user', 'add', 'bob'], ['user', '--', 'unknown'], ['user', '--', 'list', 'bob'], ['user', '--', 'add', 'bob', 'extra']]) {
    const result = f.run('remote.sh', args);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
  }
});
