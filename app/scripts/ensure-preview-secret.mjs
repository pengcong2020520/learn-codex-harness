import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROJECT_ROOT, isMain, readEnv, writeEnv } from './quickstart-lib.mjs';

export function ensurePreviewSecret(root = PROJECT_ROOT) {
  const info = fs.lstatSync(path.join(root, '.env'));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('.env 必须是普通文件。');
  const values = readEnv(root);
  if (!values.AGENT_PREVIEW_SECRET?.trim()) {
    values.AGENT_PREVIEW_SECRET = randomBytes(32).toString('hex');
    writeEnv(root, values);
  }
  return values;
}
if (isMain(import.meta.url)) {
  try {
    // 容器按文件属主降权，原子替换不改变宿主配置的 uid/gid。
    if (process.getuid?.() === 0) {
      const info = fs.lstatSync(path.join(PROJECT_ROOT, '.env'));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('.env 必须是普通文件。');
      process.setgroups([]); process.setgid(info.gid); process.setuid(info.uid);
    }
    ensurePreviewSecret();
  }
  catch { console.error('预览配置补齐失败，请检查 .env 与文件权限；内容未显示。'); process.exitCode = 1; }
}
