import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { loadModelRegistry } from '../gateway/index.mjs';
import { selectAgentFile } from '../agents/selection.mjs';
import { archiveFiles, backupName } from '../../../scripts/backup-lib.mjs';
import { checkAgent } from '../../../scripts/agent-check.mjs';

function latestBackup(root, now) {
  let latest = null;
  const walk = (directory, depth) => {
    if (!fs.lstatSync(directory).isDirectory()) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name);
      try {
        backupName(entry.name);
        const manifestFile = path.join(target, 'manifest.json');
        if (!fs.lstatSync(manifestFile).isFile()) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), time = Date.parse(manifest.time);
        if (!Number.isFinite(time) || time > now) continue;
        if (!archiveFiles.every(name => {
          const info = fs.lstatSync(path.join(target, name));
          return info.isFile() && info.size === manifest.files?.[name]?.size;
        })) continue;
        latest = Math.max(latest ?? 0, time);
      } catch {
        // 只扫描历史单节点目录和当前按节点分层的目录，不跟随链接或进入临时备份。
        if (depth < 1 && /^node-[abc]$/.test(entry.name)) walk(target, depth + 1);
      }
    }
  };
  try { walk(path.join(root, 'backups'), 0); } catch { /* 无权限或没有备份时给建议。 */ }
  return latest;
}

function agentReady(root, env) {
  try { return !checkAgent(selectAgentFile(root, env.AGENT_DEFINITION), { root }).some(row => row.level === 'error'); }
  catch { return false; }
}
function readRegistry(root) {
  try { return loadModelRegistry(root); } catch { return undefined; }
}

export function productionFileInputs({ root, now, hostAppDir }) {
  let env = {}, secure = false, readable = false, fd;
  try {
    fd = fs.openSync(path.join(root, '.env'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error();
    secure = (info.mode & 0o7777) === 0o600;
    env = parseEnv(fs.readFileSync(fd, 'utf8')); readable = true;
  } catch { /* 不输出底层错误，防止包含配置值和路径。 */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return { env, now, probes: {
    envFile: () => ({ readable, secure }),
    deploymentDirectory: () => env.CONTAINER_APP_DIR === (hostAppDir || path.resolve(root)),
    registry: () => readRegistry(root),
    providerKey: name => Boolean(env[name]?.trim()),
    backup: () => latestBackup(root, now),
    agent: () => readable && agentReady(root, env),
  } };
}

export function productionNodeInputs({ root, env, registry, now }) {
  // 不读取宿主 .env、不拿本节点备份冒充全量备份，也不以启用清单代替服务商 Key。
  return { env, now, probes: {
    registry: () => registry,
    agent: () => agentReady(root, env),
  } };
}
