import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../shared/paths.mjs';
import { backupName, run, writeManifest, pruneBackups } from './backup-lib.mjs';

// The host owns the flock and stopped service; this container only finalizes the snapshot.
export async function backup(root, name) {
  backupName(name);
  const temporary = path.join(root, 'backups', `.${name}.partial`);
  if (!fs.existsSync(temporary)) throw new Error('partial 目录不存在。');
  if (!fs.lstatSync(temporary).isDirectory() || fs.lstatSync(temporary).isSymbolicLink()) throw new Error('partial 必须是实际目录。');
  const database = path.join(temporary, 'database.sql.gz');
  if (!fs.existsSync(database) || !fs.lstatSync(database).isFile() || fs.lstatSync(database).isSymbolicLink() || fs.statSync(database).size === 0) throw new Error('partial 缺少有效的 database.sql.gz。');
  const destination = path.join(root, 'backups', name);
  if (fs.existsSync(destination)) throw new Error('备份名称已存在。');
  for (const dir of ['workspace', '.data/codex', '.data/files']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  if (!fs.existsSync(path.join(root, '.data/identity.json'))) throw new Error('缺少 .data/identity.json。请先完成初始化再备份。');
  await run('tar', ['-czf', path.join(temporary, 'workspace.tar.gz'), '-C', root, 'workspace']);
  await run('tar', ['-czf', path.join(temporary, 'codex.tar.gz'), '-C', path.join(root, '.data'), 'codex']);
  await run('tar', ['-czf', path.join(temporary, 'state.tar.gz'), '-C', path.join(root, '.data'), 'identity.json', 'files']);
  await writeManifest(temporary, root);
  fs.renameSync(temporary, destination);
  pruneBackups(root);
  console.log(`backups/${name}/manifest.json`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== '--apply' || args[1] !== '--partial') throw new Error('用法：backup.mjs --apply --partial <名称>；请从 deploy/backup.sh 调用。');
    await backup(PROJECT_ROOT, args[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
