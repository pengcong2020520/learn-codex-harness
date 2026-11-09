import fs from 'node:fs';
import path from 'node:path';
import { requireIdentity } from './context.mjs';
import { createFileTools } from '../data/files.mjs';
import { AppError } from '../../../shared/errors.mjs';
import { resourcePath } from '../data/paths.mjs';

function directory(target, parent = false, uid) {
  try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('用户工作区必须是真实目录。');
  // 用户运行环境负责根目录属主；服务端新建子目录保留共享组权限。
  if (uid !== undefined && process.getuid?.() === 0) fs.chownSync(target, uid, 1000);
  if (!parent) fs.chmodSync(target, 0o2770);
}
export function userWorkspace(workspace, ownerId = requireIdentity().userId) {
  if (!/^[a-f0-9-]{36}$/.test(ownerId || '')) throw new Error('无效 owner。');
  directory(workspace, true);
  directory(path.join(workspace, 'users'), true);
  const target = path.join(workspace, 'users', ownerId);
  directory(target);
  return target;
}
export function createUserFileTools(root, options) {
  const workspace = () => {
    options.assertCurrent?.();
    const base = userWorkspace(options.workspaceDir);
    const uid = fs.statSync(base).uid;
    for (const locator of [...(options.sources || []).map(source => source.locator), options.outputs?.directory].filter(Boolean)) {
      let target = base;
      for (const part of resourcePath(locator).split('/')) { target = path.join(target, part); directory(target, false, uid); }
    }
    return base;
  };
  const files = () => {
    const base = workspace();
    return createFileTools(root, { ...options, workspaceDir: base, uid: fs.statSync(base).uid });
  };
  return Object.defineProperties(Object.fromEntries(['check', 'check_binary', 'list_files', 'read_file', 'write_file', 'read_binary', 'write_binary'].map(name => [name, (...args) => {
    try { return files()[name](...args); }
    catch (error) { if (error.code === 'ENOENT') throw new AppError('资源不存在。', 404, 'NOT_FOUND'); throw error; }
  }])), { workspace: { get: workspace, enumerable: true }, workspaceFor: { value: owner => {
    if (!/^[a-f0-9-]{36}$/.test(owner || '')) throw new Error('无效 owner。');
    return path.join(options.workspaceDir, 'users', owner);
  } } });
}
// 事务提交前移动；中途失败可以再次执行，已移动的目录不会覆盖。
function emptyTree(target) {
  const info = fs.lstatSync(target);
  return info.isDirectory() && !info.isSymbolicLink() && fs.readdirSync(target).every(name => emptyTree(path.join(target, name)));
}
export function moveLegacyWorkspace(workspace, ownerId) {
  const target = userWorkspace(workspace, ownerId);
  const moves = ['inputs', 'research', 'drafts', 'outputs'].map(name => [path.join(workspace, name), path.join(target, name)]);
  for (const [source, dest] of moves) {
    if (!fs.existsSync(source)) continue;
    const info = fs.lstatSync(source);
    if (!info.isDirectory() || info.isSymbolicLink() || (fs.existsSync(dest) && !emptyTree(dest))) throw new Error('旧资料目录迁移冲突；未覆盖，请核对目录。');
  }
  for (const [source, dest] of moves) if (fs.existsSync(source)) {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true }); // 预检确认仅包含空目录。
    fs.renameSync(source, dest);
  }
  return target;
}
