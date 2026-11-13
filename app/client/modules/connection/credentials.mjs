import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function clientDirectory(root) {
  // Compose 的 .data 属于容器服务；宿主登录凭据放在当前用户可写的独立目录。
  return path.join(root, fs.existsSync(path.join(root, 'compose.yaml')) ? '.cli' : '.data');
}
function file(root) {
  const directory = clientDirectory(root);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('客户端数据目录不能是链接。');
  if (path.basename(directory) === '.cli') fs.chmodSync(directory, 0o700);
  return path.join(directory, 'credentials.json');
}
export function saveCredentials(root, credentials) {
  const target = file(root), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(credentials) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function readCredentials(root, url) {
  try {
    const target = file(root), info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error();
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (value.url !== url || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error();
    return value;
  } catch { throw new Error('请运行 npm run login 重新登录。'); }
}
export function removeCredentials(root) { fs.rmSync(file(root), { force: true }); }
