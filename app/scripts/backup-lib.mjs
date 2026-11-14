import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { revision } from '../server/modules/deployment/index.mjs';

export const archiveFiles = ['database.sql.gz', 'workspace.tar.gz', 'codex.tar.gz', 'state.tar.gz'];
export function backupName(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(value || '')) throw new Error('备份目录名无效。');
  return value;
}
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { size: fs.statSync(file).size, sha256: hash.digest('hex') };
}
export async function writeManifest(dir, root, time = new Date().toISOString()) {
  const files = {};
  for (const name of archiveFiles) files[name] = await digest(path.join(dir, name));
  const manifest = { time, version: revision(root), files };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}
export async function verifyManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (Object.keys(manifest.files || {}).sort().join() !== [...archiveFiles].sort().join()) throw new Error('manifest 文件清单不完整。');
  for (const name of archiveFiles) {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('备份文件类型无效。');
    const actual = await digest(file), expected = manifest.files[name];
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`备份校验失败：${name}`);
  }
  return manifest;
}
export function backupKeep(value = '7') {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('AGENT_BACKUP_KEEP 必须是非负整数；0 表示不清理。');
  return Number(value);
}
export function pruneBackups(root, value = '7') {
  const keep = backupKeep(value);
  if (keep === 0) return;
  const base = path.join(root, 'backups');
  // 调用方持有宿主 backups/.download.lock；仅清理已发布且文件齐全的快照，不跟随链接。
  const names = fs.readdirSync(base, { withFileTypes: true }).filter(entry => {
    if (!entry.isDirectory()) return false;
    try {
      backupName(entry.name);
      const directory = path.join(base, entry.name), manifestFile = path.join(directory, 'manifest.json');
      if (!fs.lstatSync(manifestFile).isFile()) return false;
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      return archiveFiles.every(name => {
        const info = fs.lstatSync(path.join(directory, name));
        return info.isFile() && info.size === manifest.files?.[name]?.size;
      });
    } catch { return false; }
  }).map(entry => entry.name).sort().reverse();
  for (const name of names.slice(keep)) fs.rmSync(path.join(base, name), { recursive: true });
}

function sqlName(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value || '')) throw new Error(`${label}无效。`);
  return value;
}
// User and database are the literals in this stage's compose.yaml, not the agent image.
export function postgresIdentity(composeText) {
  const section = composeText.split(/^  postgres:\s*$/m)[1]?.split(/^  [a-z]/m)[0] ?? '';
  const user = section.match(/^      POSTGRES_USER:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m)?.[1];
  const database = section.match(/^      POSTGRES_DB:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m)?.[1];
  if (!user || !database) throw new Error('compose.yaml 缺少 PostgreSQL 用户或库名。');
  return { user: sqlName(user, '数据库用户'), database: sqlName(database, '数据库名') };
}
// Plain SQL from the postgres:16 client. gzip is applied to stdout by the caller.
export function dumpCommand(user, database) {
  return ['docker', 'compose', 'exec', '-T', 'postgres', 'pg_dump', '--no-password', '-U', sqlName(user, '数据库用户'), '--clean', '--if-exists', '--no-owner', '--no-privileges', sqlName(database, '数据库名')];
}
// Backup is gzip plain SQL, so restore replays it with psql in the same container.
export function psqlCommand(user, database) {
  return ['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '--no-password', '-U', sqlName(user, '数据库用户'), '-d', sqlName(database, '数据库名'), '-X', '--set', 'ON_ERROR_STOP=1', '--single-transaction'];
}
// Do not echo subprocess stderr: it could contain a connection URI.
export function run(command, args, { cwd, env = process.env, input, output, gzip = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'ignore'] });
    const streams = [];
    if (input) streams.push(pipeline(input, child.stdin));
    if (output) streams.push(gzip ? pipeline(child.stdout, createGzip(), output) : pipeline(child.stdout, output));
    const ended = new Promise((done, fail) => { child.once('error', fail); child.once('close', code => code === 0 ? done() : fail(new Error(`${command} 执行失败；未输出敏感参数。`))); });
    Promise.all([ended, ...streams]).then(resolve, error => { child.kill(); reject(error); });
  });
}
// Bind mount roots cannot be removed (EBUSY). Empty children while preserving the mount.
export function clearDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('恢复目标必须是实际目录。');
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
}
