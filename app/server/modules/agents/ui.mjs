import fs from 'node:fs';
import path from 'node:path';
import { readLocalFile } from '../runtimes/user-files.mjs';

const segment = String.raw`[^./\\%?#:\u0000-\u0020\u007f][^/\\%?#:\u0000-\u0020\u007f]*`;
export const UI_ENTRY_PATTERN = `^ui/(?!.*\\.\\.)${segment}(?:/${segment})*(?![\\s\\S])`;
const uiPath = new RegExp(UI_ENTRY_PATTERN);
export const UI_MAX_BYTES = 2 * 1024 * 1024;
export const UI_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
});

export function readUiFile(directory, relative) {
  if (typeof relative !== 'string' || !uiPath.test(relative)) throw new Error('前端文件必须是 ui/ 内不含点路径、编码或特殊分隔符的相对路径。');
  const type = UI_TYPES[path.extname(relative).toLowerCase()];
  if (!type) throw new Error('前端文件类型不受支持。');
  const file = path.resolve(directory, relative);
  // 包文件可能由安装者持有；复用安全读取的目录、链接与同 fd 校验，不要求服务进程拥有它。
  const { data } = readLocalFile(fs.lstatSync(file).uid, file, { maxBytes: UI_MAX_BYTES });
  return { content: data, type };
}

export function validateUi(directory, ui, workspace) {
  if (!ui) return;
  const uiRoot = path.resolve(directory, 'ui');
  if (uiRoot === workspace || uiRoot.startsWith(workspace + path.sep) || workspace.startsWith(uiRoot + path.sep))
    throw new Error('Agent 前端目录不能与用户或模型可写的工作区重叠。');
  readUiFile(directory, ui.entry);
}
