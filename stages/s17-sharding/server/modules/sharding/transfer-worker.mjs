// Home runs as the user; workspace runs as the service (shared group 1000).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = process.argv[2];
const kind = process.argv[3], uid = Number(process.argv[4]);
if (!['home', 'workspace'].includes(kind) || !Number.isInteger(uid) || uid < 10001) throw new Error('无效迁移参数。');
// CODEX_HOME/tmp is Codex's runtime scratch (arg0 helper symlinks), recreated on every start; not user data.
const skipTop = process.argv[3] === 'home' ? new Set(['tmp']) : new Set();
function inspect(target, top = false) {
  const s = fs.lstatSync(target);
  if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink !== 1)) throw new Error('迁移拒绝链接和特殊文件。');
  if (!(kind === 'workspace' ? [0, uid] : [uid]).includes(s.uid) || ![uid, 1000].includes(s.gid)) throw new Error('迁移属主不匹配。');
  if (s.isDirectory()) for (const name of fs.readdirSync(target)) {
    if (top && skipTop.has(name)) continue;
    if (name === '..' || /[\x00-\x1f\x7f\\]/.test(name)) throw new Error('迁移文件名含控制字符。');
    inspect(path.join(target, name));
  }
}
try {
  inspect(root, true);
  const child = spawn('tar', ['--create','--numeric-owner','--format=posix','--file=-',...[...skipTop].map(name => `--exclude=./${name}`),'--directory',root,'.'], { stdio: ['ignore','inherit','inherit'] });
  child.once('error', e => { console.error(e.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (e) { console.error(e.message); process.exitCode = 1; }
