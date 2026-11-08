import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../shared/errors.mjs';
import { resourcePath, validateKnowledgeBindings } from '../data/paths.mjs';

const conflict = () => new AppError('知识库目录在操作期间变化或包含链接。', 409, 'KNOWLEDGE_PATH_CHANGED');
// These path-based checks also retain a rename/ABA window for mkdir/removal.
// Isolation mode runs those operations as the owner uid; Node has no openat2/unlinkat API.
function workspaceRoot(workspace) {
  const info = fs.lstatSync(workspace);
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflict();
  return fs.realpathSync(workspace);
}
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
function stamp(directory, root) {
  const real = fs.realpathSync(directory), stat = fs.lstatSync(directory);
  if (!inside(root, real) || !stat.isDirectory() || stat.isSymbolicLink()) throw conflict();
  return { real, dev: stat.dev, ino: stat.ino };
}
function unchanged(directory, root, before) {
  const after = stamp(directory, root);
  if (after.real !== before.real || after.dev !== before.dev || after.ino !== before.ino) throw conflict();
}
function realDirectory(directory, root) {
  // Check every component below the trusted, canonical workspace root.
  let current = root;
  stamp(current, root);
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    if (part === '..') throw conflict();
    current = path.join(current, part); stamp(current, root);
    if (fs.realpathSync(current) !== current) throw conflict();
  }
  return stamp(directory, root);
}
export const knowledgeBinding = id => validateKnowledgeBindings({ [id]: {
  sourceRoot: `inputs/${id}`, wikiRoot: `research/${id}/wiki`,
} })[id];

// Shared by knowledge:init and HTTP create. No recursive mkdir through unchecked parents.
export function prepareKnowledgeDirectories(workspace, bindings, { exclusive = false } = {}) {
  validateKnowledgeBindings(bindings);
  const root = workspaceRoot(workspace), created = [];
  const mkdir = relative => {
    let directory = root;
    for (const part of resourcePath(relative).split('/')) {
      const parent = directory; directory = path.join(parent, part);
      const before = realDirectory(parent, root);
      try {
        fs.mkdirSync(directory, { mode: 0o2770 }); created.push(directory);
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        unchanged(parent, root, before);
        const after = realDirectory(directory, root);
        if (!stat.isDirectory() || stat.dev !== after.dev || stat.ino !== after.ino) throw conflict();
      } finally { fs.closeSync(fd); }
    }
  };
  try {
    if (exclusive) for (const b of Object.values(bindings)) for (const relative of [b.sourceRoot, b.wikiRoot]) {
      try { fs.lstatSync(path.join(root, relative)); throw new AppError('知识库目录已存在，未接管。', 409); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const b of Object.values(bindings)) { mkdir(b.sourceRoot); mkdir(b.wikiRoot); }
  } catch (error) {
    for (const directory of created.reverse()) { try { fs.rmdirSync(directory); } catch {} }
    throw error.status ? error : conflict();
  }
  return null;
}

export function createSourceFile(workspace, sourceRoot, name, content, uid) {
  const root = workspaceRoot(workspace), directory = path.join(root, resourcePath(sourceRoot));
  const before = realDirectory(directory, root), source = before.real;
  const file = path.join(directory, name);
  let fd, stat;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o660);
    stat = fs.fstatSync(fd);
    // O_NOFOLLOW protects only the leaf. Bind the new fd to a stable parent before writing.
    unchanged(directory, source, before);
    realDirectory(directory, root);
    if (!stat.isFile() || stat.nlink !== 1) throw conflict();
    if (uid !== undefined && process.getuid?.() === 0) fs.fchownSync(fd, uid, 1000);
    fs.writeFileSync(fd, content); fs.fsyncSync(fd);
    unchanged(directory, source, before);
  } catch (error) {
    if (fd !== undefined) {
      // Only unlink our newly created inode, never a replacement supplied by another process.
      for (const candidate of new Set([file, path.join(before.real, name)])) {
        try { const now = fs.lstatSync(candidate); if (now.dev === stat?.dev && now.ino === stat?.ino) fs.unlinkSync(candidate); } catch {}
      }
    }
    if (error.code === 'EEXIST') throw new AppError('同名原文已存在，请更换文件名；未覆盖。', 409);
    throw error.status ? error : conflict();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  // Residual risk: path-based Node APIs cannot make the checks/unlink atomic with rename.
  // A hostile same-uid process can swap away and restore parents between checks (ABA), or
  // move the new inode out of reach before cleanup. Full closure needs openat2/unlinkat.
  // Production keeps s14 uid boundaries; these checks do not replace OS isolation.
}

export function removeKnowledgeDirectories(workspace, binding) {
  const root = workspaceRoot(workspace);
  for (const relative of [binding.sourceRoot, binding.wikiRoot]) {
    const target = path.join(root, resourcePath(relative));
    try { realDirectory(target, root); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Executed as the owner's uid in isolation mode; rm does not traverse leaf symlinks.
    fs.rmSync(target, { recursive: true });
  }
  return null;
}
