// Runs as the s14 numeric uid with an empty credential environment. No shell, no SSH.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = process.argv[2];
function inspect(target) {
  const s = fs.lstatSync(target);
  if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink !== 1)) throw new Error('迁移拒绝链接和特殊文件。');
  if (s.uid !== process.getuid() || ![process.getuid(), 1000].includes(s.gid)) throw new Error('迁移属主不匹配。');
  if (s.isDirectory()) for (const name of fs.readdirSync(target)) {
    if (/[\x00-\x1f\x7f\\]/.test(name)) throw new Error('迁移文件名含控制字符。');
    inspect(path.join(target, name));
  }
}
try {
  inspect(root);
  const child = spawn('tar', ['--create','--numeric-owner','--format=posix','--file=-','--directory',root,'.'], { stdio: ['ignore','inherit','inherit'] });
  child.once('error', () => { process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code || 0; });
} catch (e) { console.error(e.message); process.exitCode = 1; }
