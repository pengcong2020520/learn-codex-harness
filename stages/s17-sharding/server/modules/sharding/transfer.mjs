import { signalUserProcess } from '../codex/launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { prepareDirectories, assertRealPath } from '../runtimes/directories.mjs';
const exec = promisify(execFile);
export function transferPath(root, record, kind) {
  if (!/^[a-f0-9-]{36}$/.test(record.user_id) || !Number.isInteger(record.uid) || record.uid < 10001) throw new Error('无效运行环境。');
  const home = path.join(root, '.data/users', record.user_id, 'codex');
  if (![home, path.join(root, '.data/codex')].includes(record.codex_home)) throw new Error('CODEX_HOME 不合法。');
  if (kind === 'home') return record.codex_home;
  if (kind === 'workspace') return path.join(root, 'workspace/users', record.user_id);
  throw new Error('只允许 CODEX_HOME 与用户 workspace。');
}
export function exportTree(root, record, kind) {
  const directory = transferPath(root, record, kind); assertRealPath(directory);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./transfer-worker.mjs', import.meta.url)), directory], {
    uid: record.uid, gid: record.uid, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'],
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject); child.stderr.resume();
    child.once('close', code => code === 0 ? resolve() : reject(new Error('用户目录 tar 导出失败。')));
  });
  done.catch(() => {}); return { stream: child.stdout, done, async stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdout.destroy();
      if (child.pid) await signalUserProcess(child.pid, 'SIGKILL', { uid: record.uid, gid: record.uid, env: { PATH: '/usr/bin:/bin' } });
    }
    await done.catch(() => {});
  } };
}
export function validateTarListing(text, uid) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (!lines.length) throw new Error('空归档。');
  for (const line of lines) {
    // GNU tar -tv --numeric-owner --quoting-style=escape. Reject link/device types and escaped/control names.
    const match = /^([-d])[rwxStTs-]{9}\s+(\d+)\/(\d+)\s+\d+\s+\d{4}-\d{2}-\d{2}\s+[\d:]+\s+(\.\/.*)$/.exec(line);
    if (!match || Number(match[2]) !== uid || ![uid, 1000].includes(Number(match[3])) || /[\\\x00-\x1f\x7f]/.test(match[4]) || match[4].split('/').includes('..')) throw new Error('不安全的 tar 条目或数值属主。');
  }
}
export async function importTree(root, record, kind, input, beforePublish = async () => {}) {
  const target = transferPath(root, record, kind);
  const parent = path.join(root, '.data/transfers'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); assertRealPath(parent);
  const id = randomUUID(), archive = path.join(parent, id + '.tar'), stage = path.join(parent, id);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    await pipeline(input, fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    const { stdout } = await exec('tar', ['--list','--verbose','--numeric-owner','--quoting-style=escape','--file',archive], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' }, maxBuffer: 16 * 1024 * 1024 });
    validateTarListing(stdout, record.uid);
    await exec('tar', ['--extract','--same-owner','--numeric-owner','--delay-directory-restore','--file',archive,'--directory',stage], { env: { PATH: '/usr/bin:/bin' } });
    await beforePublish();
    prepareDirectories(root, record, { isolated: process.getuid() === 0 });
    // Keep any previous destination until this copy is complete. Never merge stale SQLite files.
    const previous = target + '.before-move-' + id;
    fs.renameSync(target, previous);
    try { fs.renameSync(stage, target); } catch (error) { fs.renameSync(previous, target); throw error; }
    // Previous copy is deliberately retained for operator recovery; no automatic destructive cleanup.
    return { copied: kind };
  } finally { fs.rmSync(archive, { force: true }); }
}
