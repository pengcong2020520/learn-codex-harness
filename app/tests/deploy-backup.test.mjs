import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archiveFiles, backupName, clearDirectory, postgresIdentity, dumpCommand, psqlCommand } from '../scripts/backup-lib.mjs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const name = '2026-01-09T00-00-00-000Z';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'server/modules/runtimes'), { recursive: true });
  fs.copyFileSync(new URL('../server/modules/runtimes/directories.mjs', import.meta.url), path.join(root, 'server/modules/runtimes/directories.mjs'));
  for (const file of ['scripts/backup.mjs', 'scripts/backup-lib.mjs', 'scripts/restore.mjs', 'shared/paths.mjs', 'shared/errors.mjs', 'server/modules/deployment/index.mjs', 'deploy/backup.sh', 'deploy/restore.sh', 'deploy/env-run.sh', 'deploy/download-rsync.sh', 'deploy/topology.sh', 'Dockerfile']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), read(file));
  }
  for (const dir of ['workspace', '.data/codex', '.data/users/example/codex', '.data/files', 'backups']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['workspace/example', '.data/codex/history', '.data/users/example/codex/history', '.data/files/blob', '.data/identity.json']) fs.writeFileSync(path.join(root, file), `original ${file}`);
  fs.writeFileSync(path.join(root, 'REVISION'), 'test-version');
  return root;
}
function cli(root, file, ...args) {
  return spawnSync(process.execPath, [`scripts/${file}.mjs`, ...args], { cwd: root, env: { ...process.env, AGENT_DEPLOYED: 'true' }, encoding: 'utf8' });
}
function prepare(root, value = name) {
  const partial = path.join(root, 'backups', `.${value}.partial`);
  fs.mkdirSync(partial);
  const sql = gzipSync('SELECT 1;\n');
  fs.writeFileSync(path.join(partial, 'database.sql.gz'), sql);
  return sql;
}
test('backup: CLI --apply --partial 使用已有 SQL、正确 SHA-256、版本与仅保留 7 份', t => {
  const root = fixture(t);
  let sql;
  for (let i = 1; i <= 9; i++) {
    const value = `2026-01-0${i}T00-00-00-000Z`;
    sql = prepare(root, value);
    const result = cli(root, 'backup', '--apply', '--partial', value);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /manifest.json/);
    assert.equal(fs.existsSync(path.join(root, 'backups', `.${value}.partial`)), false);
  }
  const dir = path.join(root, 'backups', name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  assert.equal(manifest.version, 'test-version');
  assert.ok(Number.isFinite(Date.parse(manifest.time)));
  assert.deepEqual(Object.keys(manifest.files), archiveFiles);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'database.sql.gz')), sql);
  for (const file of archiveFiles) {
    const content = fs.readFileSync(path.join(dir, file));
    assert.deepEqual(manifest.files[file], { size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 7);
  assert.equal(fs.existsSync(path.join(root, 'backups', '2026-01-02T00-00-00-000Z')), false);
});
test('backup: CLI 缺失 partial 或 SQL、非法名称时报错，不发布 manifest', t => {
  const root = fixture(t);
  let result = cli(root, 'backup', '--apply', '--partial', name);
  assert.equal(result.status, 1); assert.match(result.stderr, /partial 目录不存在/);
  fs.mkdirSync(path.join(root, 'backups', `.${name}.partial`));
  result = cli(root, 'backup', '--apply', '--partial', name);
  assert.equal(result.status, 1); assert.match(result.stderr, /database.sql.gz/);
  assert.equal(fs.existsSync(path.join(root, 'backups', name)), false);
  assert.throws(() => backupName('../escape'));
  assert.equal(cli(root, 'backup', '--apply', '--partial', '../escape').status, 1);
  assert.equal(cli(root, 'backup', '--apply').status, 1);
});
test('restore: CLI --verify 拒绝篡改，--files 恢复内容且保留挂载根目录', t => {
  const root = fixture(t); prepare(root);
  assert.equal(cli(root, 'backup', '--apply', '--partial', name).status, 0);
  assert.equal(cli(root, 'restore', '--verify', name).status, 0);
  const inode = fs.statSync(path.join(root, 'workspace')).ino;
  fs.writeFileSync(path.join(root, 'workspace/example'), 'changed');
  fs.writeFileSync(path.join(root, '.data/codex/new'), 'extra');
  const restored = cli(root, 'restore', '--files', name);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.statSync(path.join(root, 'workspace')).ino, inode);
  assert.equal(fs.readFileSync(path.join(root, 'workspace/example'), 'utf8'), 'original workspace/example');
  assert.equal(fs.existsSync(path.join(root, '.data/codex/new')), false);
  assert.equal(fs.readFileSync(path.join(root, '.data/users/example/codex/history'), 'utf8'), 'original .data/users/example/codex/history');
  fs.appendFileSync(path.join(root, 'backups', name, 'codex.tar.gz'), 'tamper');
  const result = cli(root, 'restore', '--verify', name);
  assert.equal(result.status, 1); assert.match(result.stderr, /校验失败/);
  fs.writeFileSync(path.join(root, 'workspace/example'), 'keep on failure');
  assert.equal(cli(root, 'restore', '--files', name).status, 1);
  assert.equal(fs.readFileSync(path.join(root, 'workspace/example'), 'utf8'), 'keep on failure');
});
test('backup: shell 静态约束、共享 flock、trap、数据库参数、容器 Node 与 npm 入口', () => {
  const backup = read('deploy/backup.sh'), restore = read('deploy/restore.sh');
  for (const file of ['backup.sh', 'restore.sh', 'download-rsync.sh']) {
    const source = read(`deploy/${file}`);
    assert.match(source, /set -euo pipefail/);
    assert.match(source, /exec 9>backups\/\.download\.lock/);
    assert.match(source, /flock -n 9/);
    assert.doesNotMatch(source, /mkdir backups\/\.operation-lock/);
  }
  for (const source of [backup, restore]) { assert.match(source, /trap \w+ EXIT/); assert.match(source, /trap 'exit 143' TERM/); }
  for (const file of fs.readdirSync(new URL('../deploy/', import.meta.url)).filter(x => x.endsWith('.sh'))) {
    const source = read(`deploy/${file}`).replace(/\\\n/g, ' ');
    assert.equal(spawnSync('bash', ['-n'], { input: source }).status, 0, file);
    for (const line of source.split('\n').filter(x => !x.trim().startsWith('#') && /(?:^|[;|]\s*)\s*(?:node|npm)\s/.test(x))) assert.match(line, /docker (compose|run)/, `${file}: ${line}`);
  }
  const { user, database } = postgresIdentity(read('compose.yaml'));
  assert.ok(backup.includes(dumpCommand(user, database).join(' ')));
  assert.ok(restore.includes(psqlCommand(user, database).join(' ')));
  assert.match(backup, /docker compose run --rm --no-deps -T --cap-add DAC_READ_SEARCH "\$node" node scripts\/backup.mjs --apply --partial/);
  assert.match(restore, /docker compose run --rm --no-deps -T "\$node" node scripts\/restore.mjs --verify/);
  assert.match(restore, /docker compose run --rm --no-deps -T --cap-add DAC_OVERRIDE "\$node" node scripts\/restore.mjs --files/);
  assert.match(restore, /\/dev\/tty/); assert.match(restore, /--yes/); assert.match(restore, /bash deploy\/cluster-ready.sh/);
  assert.doesNotMatch(read('Dockerfile'), /postgresql-client/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.backup, 'bash deploy/backup.sh'); assert.equal(pkg.scripts.restore, 'bash deploy/restore.sh');
  assert.match(read('deploy/remote.sh'), /backup\) remote .*bash deploy\/backup.sh/);
});

// Docker/flock are controlled fixtures here; real kernel locking is covered separately on Linux.
function shellFixture(t) {
  const root = fixture(t);
  fs.copyFileSync(new URL('../deploy/cluster-ready.sh', import.meta.url), path.join(root, 'deploy/cluster-ready.sh'));
  fs.mkdirSync(path.join(root, 'bin'));
  const stubs = {
    flock: '#!/bin/bash\nexit "${LOCK_STATUS:-0}"\n',
    id: '#!/bin/bash\necho 1000\n',
    docker: `#!/bin/bash
set -eu
if [[ "$*" == *scripts/cluster-config.mjs* ]]; then echo 'node-a node-b node-c'; exit 0; fi
printf '%s\\n' "$*" >> "$PWD/calls"
if [[ -n "\${FAIL_AT:-}" && "$*" == *"$FAIL_AT"* ]]; then exit 19; fi
case "$*" in
  *pg_dump*) printf 'SELECT 1;\\n' ;;
  *psql*) cat > "$PWD/restored.sql" ;;
  *scripts/backup.mjs*)
    name="\${!#}"
    for shard_node in node-a node-b node-c; do
      if [[ "$*" == *"$shard_node node scripts/backup.mjs"* ]]; then
        cp "backups/$shard_node/.$name.partial/database.sql.gz" captured.sql.gz
        mv "backups/$shard_node/.$name.partial" "backups/$shard_node/$name"
      fi
    done
    ;;
esac
`,
  };
  for (const [file, content] of Object.entries(stubs)) fs.writeFileSync(path.join(root, 'bin', file), content, { mode: 0o755 });
  const run = (file, args = [], env = {}) => spawnSync('bash', [`deploy/${file}.sh`, ...args], {
    cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ...env }, encoding: 'utf8', detached: true, timeout: 30000, killSignal: 'SIGKILL',
  });
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n') : [];
  return { root, run, calls };
}
test('backup: Bash 管道成功、dump/打包失败都重启且清理 partial，锁冲突不停止服务', t => {
  for (const fail of ['', 'pg_dump', 'scripts/backup.mjs']) {
    const f = shellFixture(t);
    const result = f.run('backup', [], { FAIL_AT: fail });
    assert.equal(result.status, fail ? 19 : 0, result.stderr);
    assert.equal(f.calls()[0], 'compose stop node-a node-b node-c');
    assert.ok(f.calls().includes('compose up -d --wait node-a node-b node-c caddy'));
    assert.match(f.calls().at(-1), /caddy wget.*ready/);
    assert.equal(fs.readdirSync(path.join(f.root, 'backups')).some(x => x.endsWith('.partial')), false);
    if (!fail) assert.equal(gunzipSync(fs.readFileSync(path.join(f.root, 'captured.sql.gz'))).toString(), 'SELECT 1;\n');
    if (fail === 'pg_dump') assert.equal(f.calls().some(x => x.includes('scripts/backup.mjs')), false);
  }
  const f = shellFixture(t);
  assert.equal(f.run('backup', [], { LOCK_STATUS: '75' }).status, 75);
  assert.deepEqual(f.calls(), []);
});
test('restore: Bash 顺序、非交互拒绝、校验/SQL/文件/启动/ready 失败均保持停止', t => {
  for (const fail of ['', '--verify', 'psql', 'cluster-migrate.mjs', '--files', 'up -d', 'http://127.0.0.1/ready']) {
    const f = shellFixture(t);
    fs.mkdirSync(path.join(f.root, 'backups/node-a', name), {recursive:true});
    fs.writeFileSync(path.join(f.root, 'backups/node-a', name, 'database.sql.gz'), gzipSync('SELECT 1;\n'));
    const result = f.run('restore', [name, '--yes'], { FAIL_AT: fail });
    assert.equal(result.status, fail ? 19 : 0, result.stderr);
    const calls = f.calls();
    assert.equal(calls[0], 'compose stop node-a node-b node-c');
    if (fail) { assert.equal(calls.at(-1), 'compose stop node-a node-b node-c'); assert.match(result.stderr, /agent 保持停止/); }
    else {
      assert.ok(calls.slice(1,4).every(x=>x.includes('--verify'))); assert.match(calls[4], /psql/); assert.match(calls[5], /cluster-migrate.mjs/); assert.ok(calls.slice(6,9).every(x=>x.includes('--files')));
      assert.equal(calls[9], 'compose up -d --wait node-a node-b node-c'); assert.match(calls.at(-1), /caddy wget.*ready/);
      assert.equal(fs.readFileSync(path.join(f.root, 'restored.sql'), 'utf8'), 'SELECT 1;\n');
    }
    if (fail === '--verify') assert.equal(calls.some(x => /psql|--files|up -d/.test(x)), false);
    if (fail === 'psql' || fail === 'cluster-migrate.mjs' || fail === '--files') assert.equal(calls.some(x => /up -d/.test(x)), false);
  }
  const f = shellFixture(t);
  const denied = f.run('restore', [name]);
  assert.equal(denied.status, 1); assert.match(denied.stderr, /非交互执行须显式传入 --yes/);
  assert.deepEqual(f.calls(), ['compose stop node-a node-b node-c', 'compose stop node-a node-b node-c']);
  const locked = shellFixture(t);
  assert.equal(locked.run('restore', [name, '--yes'], { LOCK_STATUS: '75' }).status, 75); assert.deepEqual(locked.calls(), []);
  const broken = shellFixture(t);
  fs.mkdirSync(path.join(broken.root, 'backups/node-a', name), {recursive:true});
  fs.writeFileSync(path.join(broken.root, 'backups/node-a', name, 'database.sql.gz'), 'bad gzip');
  assert.notEqual(broken.run('restore', [name, '--yes']).status, 0);
  assert.equal(broken.calls().some(x => /--files|up -d/.test(x)), false);
  assert.equal(broken.calls().at(-1), 'compose stop node-a node-b node-c');
});
test('backup: 恢复只清空目录内容，保留 bind mount 根目录', t => {
  const root = fixture(t), dir = path.join(root, 'workspace');
  const inode = fs.statSync(dir).ino;
  clearDirectory(dir);
  assert.equal(fs.statSync(dir).ino, inode); assert.deepEqual(fs.readdirSync(dir), []);
});
