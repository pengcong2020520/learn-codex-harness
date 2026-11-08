import fs from 'node:fs';
import path from 'node:path';

export function isolationMode({ uid = process.getuid?.(), container = fs.existsSync('/.dockerenv') || process.env.AGENT_DEPLOYED === 'true', log = console.warn } = {}) {
  if (uid === 0) return true;
  if (container) throw new Error('容器内无法切换系统用户，拒绝启动。');
  log('本机开发模式：未启用系统用户隔离');
  return false;
}
export function assertRealPath(target) {
  let current = path.parse(path.resolve(target)).root;
  for (const part of path.resolve(target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error('运行环境路径不能包含符号链接。');
  }
}
function directory(target) {
  try { fs.mkdirSync(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('运行环境目录必须是真实目录，拒绝符号链接。');
}
// 系统父目录仅供穿越；不开放枚举。用户边界目录始终是 uid:1000 / 2770。
export function prepareDirectories(root, record, { isolated, workspace = path.join(root, 'workspace') }) {
  if (!/^[a-f0-9-]{36}$/.test(record.user_id)) throw new Error('无效 owner。');
  assertRealPath(root);
  const parent = target => {
    directory(target);
    if (isolated) { fs.chownSync(target, 0, 1000); fs.chmodSync(target, 0o711); }
  };
  parent(path.join(root, '.data')); parent(path.join(root, '.data/users'));
  parent(path.join(root, '.runs')); parent(path.join(root, '.runs/users'));
  assertRealPath(path.dirname(workspace)); parent(workspace); parent(path.join(workspace, 'users'));
  parent(path.join(root, '.data/users', record.user_id));
  const expected = [path.join(root, '.data/codex'), path.join(root, '.data/users', record.user_id, 'codex')];
  if (!expected.includes(record.codex_home)) throw new Error('CODEX_HOME 映射不在允许目录内。');
  const paths = { codexHome: record.codex_home, workspaceDir: path.join(workspace, 'users', record.user_id), runsDir: path.join(root, '.runs/users', record.user_id) };
  for (const target of Object.values(paths)) {
    directory(target); assertRealPath(target);
    secureTree(target, record.uid, isolated);
  }
  return paths;
}
// 只在进程尚未启动、目录树无并发写入时迁移/修复权限，不改写原生内容。
// lstat 只用于避免打开特殊文件；安全判断与权限修改都绑定到 O_NOFOLLOW 打开的 fd。
// 目录 fd 在遍历期间保持打开；子项仍按目录所在路径访问，父目录被替换的残余竞态尚未消除。
function walkTree(root, update) {
  assertRealPath(root);
  const walk = target => {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return;
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
        (info.isDirectory() ? fs.constants.O_DIRECTORY : 0) | fs.constants.O_NONBLOCK);
    } catch (error) { if (error.code === 'ELOOP') return; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isDirectory() && !stat.isFile()) return;
      if (stat.isFile() && stat.nlink > 1) throw new Error('运行环境拒绝硬链接文件。');
      update(fd, stat);
      if (stat.isDirectory()) for (const name of fs.readdirSync(target)) walk(path.join(target, name));
    } finally { fs.closeSync(fd); }
  };
  walk(root);
}
export function secureTree(root, uid, isolated) {
  walkTree(root, (fd, stat) => {
    if (isolated) fs.fchownSync(fd, uid, 1000);
    fs.fchmodSync(fd, stat.isDirectory() ? 0o2770 : 0o660);
  });
}

// 容器根进程没有 DAC_OVERRIDE；启动前接管服务自己的旧文件，随后才读身份和锁。
// 原生目录交给用户映射迁移，绝不把用户树改成服务所有。
export function prepareServiceDirectories(root, isolated) {
  if (!isolated) return;
  assertRealPath(root);
  for (const name of ['.data', '.runs', 'workspace', 'backups']) {
    const target = path.join(root, name); directory(target);
    fs.chownSync(target, 0, 1000); fs.chmodSync(target, 0o711);
    if (name === '.data') {
      for (const entry of fs.readdirSync(target)) if (!['users', 'codex'].includes(entry)) secureTree(path.join(target, entry), 0, true);
    }
  }
}

// 停服备份/恢复时修复可读权限，保留每个文件原来的 uid（不把多个用户归为同一 uid）。
export function repairRuntimeAccess(root) {
  if (process.getuid?.() !== 0) return;
  walkTree(root, (fd, stat) => {
    fs.fchownSync(fd, stat.uid, 1000);
    fs.fchmodSync(fd, stat.isDirectory() ? 0o2770 : 0o660);
  });
}
