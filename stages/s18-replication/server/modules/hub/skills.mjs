import { createHash } from 'node:crypto';
import { AppError } from '../../../shared/errors.mjs';
// 与 Agent 包保持同一文本白名单；HTTP 不接受 tar/zip，因而没有链接或解压穿越入口。
export function validateUpload({ name, files, ...rest }) {
  if (Object.keys(rest).length || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || '') || !files || Array.isArray(files) || typeof files !== 'object') throw new AppError('Skill 上传格式无效。', 400);
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1);
  if (!Object.hasOwn(files, 'SKILL.md') || !files['SKILL.md']?.trim() || entries.length > 50) throw new AppError('需要 SKILL.md，最多 50 个文本文件。', 400);
  let bytes = 0;
  for (const [file, text] of entries) {
    if (typeof text !== 'string' || text.includes('\0') || !(file === 'SKILL.md' || /^references\/(?:[^./\\\x00-\x1f][^/\\\x00-\x1f]*\/)*[^./\\\x00-\x1f][^/\\\x00-\x1f]*\.(md|txt)$/.test(file)) || file.split('/').some(part => part === '..' || part === '.')) throw new AppError('只允许 SKILL.md 与 references/ 下的 .md/.txt 文本。', 400);
    bytes += Buffer.byteLength(text);
  }
  if (bytes > 128 * 1024) throw new AppError('Skill 总大小不能超过 128 KiB。', 413);
  return { name, files: Object.fromEntries(entries), version: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
export const skillSignature = skills => JSON.stringify(skills.map(({ id, version }) => [id, version]).sort());
export function packagedSkill(row) {
  return { id: row.id, name: row.name, scope: row.scope, owner_id: row.owner_id, type: 'skill', required: true,
    source: 'hub', path: `hub/${row.id}/SKILL.md`, files: Object.keys(row.files), version: row.version,
    contents: Object.fromEntries(Object.entries(row.files).map(([file, text]) => [file, Buffer.from(text).toString('base64')])) };
}
