import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signalUserProcess } from '../codex/launch.mjs';

const worker = fileURLToPath(new URL('./user-files-worker.mjs', import.meta.url));
export const USER_FILE_TIMEOUT_MS = 5000;
const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };

// 此函数只在用户子进程或不能切 uid 的本机模式执行；校验和读取绑定同一 fd。
export function readLocalFile(uid, file, { maxBytes, truncate = false, metadataOnly = false }) {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.dirname(path.resolve(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('读取目录必须是真实目录。');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('读取产物必须是独立普通文件。');
    if (stat.uid !== uid) throw new Error('读取产物属主不匹配。');
    const chunks = []; let length = 0;
    while (!metadataOnly && length <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1 - length));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      chunks.push(buffer.subarray(0, count)); length += count;
    }
    if (length > maxBytes && !truncate) throw Object.assign(new Error('用户文件超过读取上限。'), { code: 'ERR_USER_FILE_LIMIT' });
    return { data: Buffer.concat(chunks).subarray(0, maxBytes), metadata: {
      bytes: stat.size, updatedAt: stat.mtime.toISOString(), truncated: length > maxBytes,
    } };
  } finally { fs.closeSync(fd); }
}

// 子进程不继承服务密钥/Node 注入变量；stdout 为正文，fd 3 仅携带有上限的元数据。
// 没有 KILL capability 时，超时/超限由同 uid 信号发送器终止，不能依赖 child.kill()。
export function runUserFileTask(uid, task, { maxBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024) throw new Error('用户文件读取参数无效。');
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [worker], {
      uid, gid: uid, cwd: '/', env: environment, stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    });
    const output = [], meta = []; let bytes = 0, metaBytes = 0, failure, timer;
    const stop = error => {
      if (failure) return;
      failure = error;
      if (child.pid) void signalUserProcess(child.pid, 'SIGKILL', { uid, gid: uid, env: environment }, childProcess.spawn).catch(reject);
    };
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(Object.assign(new Error('用户文件超过读取上限。'), { code: 'ERR_USER_FILE_LIMIT' }));
      else if (!failure) output.push(chunk);
    });
    child.stdio[3].on('data', chunk => {
      metaBytes += chunk.length;
      if (metaBytes > 4096) stop(new Error('用户文件元数据超过上限。'));
      else if (!failure) meta.push(chunk);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      try {
        const metadata = JSON.parse(Buffer.concat(meta).toString('utf8'));
        if (code !== 0 || metadata.error) throw Object.assign(new Error(metadata.error || '用户文件辅助进程失败。'), { code: metadata.code, status: metadata.status });
        resolve({ data: Buffer.concat(output), metadata });
      } catch (error) { reject(error); }
    });
    timer = setTimeout(() => stop(Object.assign(new Error('用户文件读取超时。'), { code: 'ETIMEDOUT' })), USER_FILE_TIMEOUT_MS);
    child.stdin.end(JSON.stringify(task));
  });
}

export async function readAsUser(uid, file, { maxBytes, isolated = process.getuid?.() === 0 && uid !== process.getuid(), metadata = false, truncate = false, metadataOnly = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024) throw new Error('必须指定有效的读取上限。');
  const options = { maxBytes, truncate, metadataOnly };
  const result = isolated
    ? await runUserFileTask(uid, { operation: 'read', file, options }, { maxBytes })
    : readLocalFile(process.getuid?.() ?? uid, file, options);
  return metadata ? result : result.data;
}

export async function userFileOperation(uid, operation, input) {
  const result = await runUserFileTask(uid, { operation, ...input });
  return JSON.parse(result.data.toString('utf8'));
}
