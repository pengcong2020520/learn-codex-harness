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
// The DB is shared by nodes; its absolute home records the allocating node's root.
// Only the two known layouts can be rebased, never an arbitrary stored path.
export function runtimeHome(root, record) {
  const stored = record.codex_home;
  const layouts = ['.data/codex', `.data/users/${record.user_id}/codex`];
  if (!/^[a-f0-9-]{36}$/.test(record.user_id) || typeof stored !== 'string' || !path.isAbsolute(stored) ||
      path.normalize(stored) !== stored || /[\x00-\x1f\x7f\\]/.test(stored)) throw new Error('CODEX_HOME 映射不在允许目录内。');
  const layout = layouts.find(value => stored.endsWith('/' + value));
  if (!layout) throw new Error('CODEX_HOME 映射不在允许目录内。');
  return path.join(root, layout);
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
  const paths = { codexHome: runtimeHome(root, record), workspaceDir: path.join(workspace, 'users', record.user_id), runsDir: path.join(root, '.runs/users', record.user_id) };
  for (const target of Object.values(paths)) {
    directory(target); assertRealPath(target);
    secureDirectory(target, record.uid, isolated);
  }
  return paths;
}
// 每次启动只打开三个边界目录本身；Codex 的 0600 文件不能由服务进程打开。
export function secureDirectory(root, uid, isolated) {
  assertRealPath(root);
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw new Error('运行环境目录必须是真实目录。');
    if (isolated) fs.fchownSync(fd, uid, 1000);
    fs.fchmodSync(fd, 0o2770);
  } finally { fs.closeSync(fd); }
}

// 只用于服务自有文件，不能用于 CODEX_HOME 或 .runs/users 内部。
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
      // gateway/ is deployment config read by the gateway container (another uid); nodes must not tighten it.
      for (const entry of fs.readdirSync(target)) if (!['users', 'codex', 'transfers', 'gateway'].includes(entry)) secureTree(path.join(target, entry), 0, true);
    }
  }
}

// 一次性旧目录移交：调用方持有迁移锁，migrated_at 为空并确认该 uid 无进程。
// 此 uid 在本版本完成标记前不允许启动（首次移交时从未运行过进程），无人能调换条目，
// 因而这里可按路径 lchown/chmod；不能先 open：旧属主的显式 0600 会触发 EACCES。
export function migrateLegacyTree(root, uid) {
  assertRealPath(root);
  const walk = target => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return;
    if (stat.isFile() && stat.nlink !== 1) throw new Error('运行环境拒绝硬链接文件。');
    fs.lchownSync(target, uid, 1000);
    fs.chmodSync(target, stat.isDirectory() ? 0o2770 : (stat.mode & 0o7777) | 0o060);
    if (stat.isDirectory()) for (const name of fs.readdirSync(target)) walk(path.join(target, name));
  };
  walk(root);
}

// /proc 的检查失败必须阻止迁移，不能把不可见的进程当成不存在。
export function uidHasProcesses(uid) {
  if (process.platform !== 'linux') throw new Error('旧目录移交需要 Linux /proc 进程检查。');
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let status;
    try { status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const ids = status.match(/^Uid:\s+(.+)$/m);
    if (!ids) throw new Error('无法核验进程 uid，拒绝移交旧目录。');
    if (ids[1].trim().split(/\s+/).map(Number).includes(uid)) return true;
  }
  return false;
}
