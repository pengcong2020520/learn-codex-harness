// 打包清单由 Git 提供，再过滤运行数据与凭据；worktree 模式也只收未被忽略的文件。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { STAGE_DEFINITIONS } from './run-stages.mjs';
const roots = ['course', ...STAGE_DEFINITIONS.map(stage => `stages/${stage.directory}`)];
export function deployable(file) {
  if (!roots.some(root => file.startsWith(`${root}/`))) return false;
  const parts = file.split('/');
  if (parts.some(part => ['node_modules', '.data', '.runs', 'workspace', '.git', '.ssh', '.aws', '.codex', '.agents', 'stages-data'].includes(part))) return false;
  return !parts.some(part => (part.startsWith('.env') && part !== '.env.example') ||
    /^(?:\.npmrc|auth\.json|credentials(?:\.json)?|id_rsa.*|id_ed25519.*)$/.test(part) || /\.(?:pem|key|p12|pfx|log)$/i.test(part));
}
function command(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${cmd} 失败：${result.stderr || result.error?.message || result.status}`);
  return result.stdout;
}
export function packageDeploy(root, output, source = 'head') {
  root = fs.realpathSync(root);
  if (!['head', 'worktree'].includes(source)) throw new Error('DEPLOY_SOURCE 只能是 head 或 worktree。');
  const args = source === 'head' ? ['ls-tree', '-r', '-z', '--name-only', 'HEAD'] : ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const files = [...new Set(command('git', ['-C', root, ...args, '--', ...roots]).split('\0').filter(deployable))];
  if (!files.includes('course/deploy/stages.Dockerfile')) throw new Error('所选来源缺少阶段部署文件；未提交的改动请使用 DEPLOY_SOURCE=worktree。');
  fs.mkdirSync(output, { recursive: true });
  if (source === 'head') {
    const archive = path.join(output, '.deploy.tar'), fd = fs.openSync(archive, 'w');
    try { command('git', ['-C', root, 'archive', 'HEAD', '--', ...files], { stdio: ['ignore', fd, 'pipe'] }); }
    finally { fs.closeSync(fd); }
    command('tar', ['-xf', archive, '-C', output]);
    fs.unlinkSync(archive);
  } else {
    for (const file of files) {
      const from = path.join(root, file);
      if (!fs.existsSync(from)) continue; // 已删除但尚未提交的文件。
      const stat = fs.lstatSync(from);
      if (!stat.isFile() || fs.realpathSync(from) !== path.resolve(from)) throw new Error(`部署文件不能是符号链接：${file}`);
      const target = path.join(output, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(from, target);
      fs.chmodSync(target, stat.mode & 0o777);
    }
  }
  // HEAD 中的链接也不能逃逸构建上下文。
  function verify(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('部署包不接受符号链接。');
      if (item.isDirectory()) verify(path.join(directory, item.name));
    }
  }
  verify(output);
  const revision = command('git', ['-C', root, 'rev-parse', '--short', 'HEAD']).trim();
  fs.writeFileSync(path.join(output, 'course/REVISION'), `${revision}${source === 'worktree' ? '-worktree' : ''}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { packageDeploy(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
