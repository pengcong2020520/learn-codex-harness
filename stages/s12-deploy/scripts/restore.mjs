import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../shared/paths.mjs';
import { backupName, verifyManifest, run, clearDirectory } from './backup-lib.mjs';

// The host holds the shared lock and restores SQL. Bind mount roots must remain intact.
export async function restoreFiles(root, name) {
  const dir = path.join(root, 'backups', backupName(name));
  await verifyManifest(dir);
  for (const item of ['workspace', '.data/codex', '.data/files']) clearDirectory(path.join(root, item));
  await run('tar', ['-xzf', path.join(dir, 'workspace.tar.gz'), '-C', root]);
  for (const file of ['codex.tar.gz', 'state.tar.gz']) await run('tar', ['-xzf', path.join(dir, file), '-C', path.join(root, '.data')]);
  console.log('文件恢复完成。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, name, ...extra] = process.argv.slice(2);
    if (!['--verify', '--files'].includes(mode) || extra.length) throw new Error('用法：restore.mjs --verify|--files <名称>；请从 deploy/restore.sh 调用。');
    backupName(name);
    if (mode === '--verify') {
      await verifyManifest(path.join(PROJECT_ROOT, 'backups', name));
      console.log('manifest 校验通过。');
    } else await restoreFiles(PROJECT_ROOT, name);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
