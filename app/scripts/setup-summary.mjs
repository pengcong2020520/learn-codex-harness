import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, isMain, validateUsername } from './quickstart-lib.mjs';

// 汇总只保存向导确认的用户名；密码、哈希和模型凭据均不属于汇总。
export function writeSetupSummary(root, username) {
  if (typeof username !== 'string') throw new Error('向导汇总缺少管理员用户名。');
  validateUsername(username);
  fs.mkdirSync(path.join(root, '.data'), { recursive: true });
  const file = path.join(root, '.data/setup-summary.json'), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ username }) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readSetupSummary(root) {
  let fd;
  try {
    fd = fs.openSync(path.join(root, '.data/setup-summary.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 1024) throw new Error();
    const { username } = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (typeof username !== 'string') throw new Error();
    validateUsername(username);
    return `管理员用户名（向导记录）：${username}`;
  } catch (error) {
    if (error.code === 'ENOENT') return '管理员用户名：未保存向导汇总，请使用已有管理员账号。';
    throw new Error('无法读取向导汇总，请核对 .data/setup-summary.json；内容未显示。');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root' || !path.isAbsolute(args[1]))) throw new Error('用法：node scripts/setup-summary.mjs [--root <绝对目录>]。');
    process.stdout.write(readSetupSummary(args[1] || PROJECT_ROOT) + '\n');
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
