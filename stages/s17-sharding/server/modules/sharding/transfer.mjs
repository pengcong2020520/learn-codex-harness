import { signalUserProcess } from '../codex/launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { prepareDirectories, assertRealPath, runtimeHome } from '../runtimes/directories.mjs';
import { stderrCollector, subprocessFailure } from './transfer-diagnostics.mjs';
const exec = promisify(execFile);
export function transferPath(root, record, kind) {
  if (!/^[a-f0-9-]{36}$/.test(record.user_id) || !Number.isInteger(record.uid) || record.uid < 10001) throw new Error('无效运行环境。');
  const home = runtimeHome(root, record);
  if (kind === 'home') return home;
  if (kind === 'workspace') return path.join(root, 'workspace/users', record.user_id);
  throw new Error('只允许 CODEX_HOME 与用户 workspace。');
}
export function exportTree(root, record, kind) {
  const directory = transferPath(root, record, kind); assertRealPath(directory);
  const identity = kind === 'home' ? { uid: record.uid, gid: record.uid } : { uid: process.getuid(), gid: process.getgid() };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./transfer-worker.mjs', import.meta.url)), directory, kind, String(record.uid)], {
    ...identity, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'],
  });
  const stderr = stderrCollector(); child.stderr.on('data', chunk => stderr.append(chunk));
  const done = new Promise((resolve, reject) => {
    child.once('error', error => reject(subprocessFailure(error, { kind, phase: 'export', stderr: stderr.text })));
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(subprocessFailure(new Error('用户目录 tar 导出失败。'),
      { kind, phase: 'export', stderr: stderr.text, exitCode: code, signal })));
  });
  done.catch(() => {}); return { stream: child.stdout, done, async stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdout.destroy();
      if (child.pid) await signalUserProcess(child.pid, 'SIGKILL', { ...identity, env: { PATH: '/usr/bin:/bin' } });
    }
    await done.catch(() => {});
  } };
}
export function validateTarListing(text, uid, kind = 'home') {
  if (!['home', 'workspace'].includes(kind)) throw new Error('无效目录类型。');
  const lines = text.trim().split('\n').filter(Boolean);
  if (!lines.length) throw new Error('空归档。');
  const entries = new Map();
  for (const line of lines) {
    // GNU tar -tv --numeric-owner --quoting-style=escape. Reject link/device types and escaped/control names.
    const match = /^([-d])[rwxStTs-]{9}\s+(\d+)\/(\d+)\s+\d+\s+\d{4}-\d{2}-\d{2}\s+[\d:]+\s+(\.\/.*)$/.exec(line);
    if (!match || !(kind === 'workspace' ? [0, uid] : [uid]).includes(Number(match[2])) || ![uid, 1000].includes(Number(match[3])) || /[\\\x00-\x1f\x7f]/.test(match[4]) || match[4].split('/').includes('..')) throw new Error('不安全的 tar 条目或数值属主。');
    const name = path.posix.normalize(match[4]);
    const key = name.replace(/\/$/, '') || '.';
    if (entries.has(key)) throw new Error('重复 tar 条目。');
    entries.set(key, { uid: Number(match[2]), gid: Number(match[3]), directory: match[1] === 'd' });
  }
  return entries;
}
async function tar(kind, phase, args) {
  try { return await exec('tar', args, { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' }, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { throw subprocessFailure(error, { kind, phase, stderr: error.stderr }); }
}
function restoreOwners(stage, entries) {
  // Extraction stays service-owned, including private 0700/0600 home entries.
  // Transfer ownership bottom-up only after tar closes every file: no DAC capability needed.
  let visited = 0;
  const visit = (target, name) => {
    const stat = fs.lstatSync(target), entry = entries.get(name);
    if (!entry || stat.isSymbolicLink() || (entry.directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('解包内容与校验清单不符。');
    visited++;
    if (stat.isDirectory()) for (const child of fs.readdirSync(target)) visit(path.join(target, child), name === '.' ? child : `${name}/${child}`);
    fs.chownSync(target, entry.uid, entry.gid);
    fs.chmodSync(target, stat.mode & 0o7777); // chown may clear permission bits.
  };
  visit(stage, '.');
  if (visited !== entries.size) throw new Error('解包条目缺失。');
}
export async function importTree(root, record, kind, input, beforePublish = async () => {}) {
  const target = transferPath(root, record, kind);
  const parent = path.join(root, '.data/transfers'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); assertRealPath(parent);
  const id = randomUUID(), archive = path.join(parent, id + '.tar'), stage = path.join(parent, id);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    await pipeline(input, fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    const { stdout, stderr } = await tar(kind, 'list', ['--list','--verbose','--numeric-owner','--quoting-style=escape','--file',archive]);
    let entries;
    try { entries = validateTarListing(stdout, record.uid, kind); }
    catch (error) { throw subprocessFailure(error, { kind, phase: 'validate', stderr, exitCode: 0 }); }
    const extracted = await tar(kind, 'extract', ['--extract','--no-same-owner','--same-permissions','--numeric-owner','--delay-directory-restore','--file',archive,'--directory',stage]);
    try { restoreOwners(stage, entries); }
    catch (error) { throw subprocessFailure(error, { kind, phase: 'restore', stderr: extracted.stderr, exitCode: 0 }); }
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
