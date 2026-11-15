import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { authenticateNode } from '../modules/sharding/node-auth.mjs';
import { AppError } from '../../shared/errors.mjs';
import { defaultViewports, parseViewports } from '../../scripts/layout-check.mjs';

export const HTML_LIMIT = 2 * 1024 * 1024;
export const CHECK_TIMEOUT_MS = 60000;
const timeoutError = () => new AppError('检查超时', 504, 'DESIGN_CHECK_TIMEOUT');

export function validateCheck(body) {
  if (!body || typeof body.html !== 'string' || !body.html.trim() || Object.keys(body).some(key => !['html', 'viewports'].includes(key))) throw new AppError('请提交 html 字符串和可选的 viewports 数组。');
  if (Buffer.byteLength(body.html) > HTML_LIMIT) throw new AppError('HTML 不能超过 2 MiB。', 413);
  const viewports = body.viewports === undefined ? defaultViewports : body.viewports;
  if (!Array.isArray(viewports) || !viewports.length || viewports.some(v => !v || Object.keys(v).some(k => !['width', 'height'].includes(k)) || !Number.isSafeInteger(v.width) || !Number.isSafeInteger(v.height))) throw new AppError('viewports 必须包含整数 width 和 height。');
  try { parseViewports(viewports.map(v => `${v.width}x${v.height}`).join(',')); }
  catch { throw new AppError('视口宽高必须为正的安全整数。'); }
  return { html: body.html, viewports };
}

export function chromiumEnv(directory) {
  // 容器根文件系统只读，Crashpad 需要可写的 HOME 与 XDG 目录；只传启动必需的环境变量。
  const config = path.join(directory, '.config'), cache = path.join(directory, '.cache');
  for (const target of [config, cache]) fs.mkdirSync(target, { mode: 0o700 });
  return {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: directory, HOME: directory,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, CHROME_PATH: '/usr/bin/chromium',
  };
}

// 整个进程组退出后才释放串行槽，避免超时的 Chromium 继续占用内存。
export async function runCheck({ html, viewports }, signal) {
  signal.throwIfAborted();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'design-check-'));
  const file = path.join(directory, 'page.html');
  fs.writeFileSync(file, html, { mode: 0o600 });
  let child;
  const kill = () => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  try {
    return await new Promise((resolve, reject) => {
      let result, failure;
      child = fork(new URL('./worker.mjs', import.meta.url), [], {
        detached: true, cwd: directory, execArgv: [],
        env: chromiumEnv(directory),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const abort = () => { failure = signal.reason; kill(); };
      child.once('message', value => { result = value; });
      child.once('error', () => { failure = new AppError('布局校验服务不可用', 503); });
      child.once('close', () => {
        signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (!result?.report) reject(new AppError(result?.error || '布局校验服务不可用', 503));
        else resolve(result.report);
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else child.send({ file, viewports });
    });
  } finally { kill(); fs.rmSync(directory, { recursive: true, force: true }); }
}

export function createCheckQueue({ run = runCheck, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  let tail = Promise.resolve();
  return (input, signal) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) onAbort();
    });
    const work = tail.then(() => { combined.throwIfAborted(); return run(input, combined); });
    tail = work.catch(() => {});
    // 排队也计入 60 秒，过期请求不会在客户端离开后继续运行。
    return Promise.race([work, aborted]).finally(() => { clearTimeout(timer); combined.removeEventListener('abort', onAbort); });
  };
}

export function createCheckHandler({ keyHashes, check = createCheckQueue() }) {
  return async (request, response) => {
    const send = (status, value) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); } };
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(new AppError('调用已取消。', 499)); };
    response.once('close', disconnect);
    try {
      if (request.method === 'GET' && request.url === '/health') { send(200, { ok: true }); return; }
      authenticateNode(request.headers, keyHashes);
      if (request.method !== 'POST' || request.url !== '/check') throw new AppError('接口不存在。', 404);
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new AppError('请求必须使用 application/json。', 415);
      // JSON 的 Unicode 转义最多占六倍字节；HTML 解码后另按 2 MiB 检查。
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > HTML_LIMIT * 6 + 4096) throw new AppError('请求内容过大。', 413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('请求不是有效 JSON。'); }
      send(200, await check(validateCheck(body), controller.signal));
    } catch (error) { send(error.status || 503, { error: error.status ? error.message : '布局校验服务不可用' }); }
    finally { response.off('close', disconnect); }
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const keyHashes = Object.fromEntries(['A', 'B', 'C'].map(suffix => [`node-${suffix.toLowerCase()}`, process.env[`AGENT_NODE_KEY_${suffix}_HASH`]]).filter(([, hash]) => hash));
  if (!Object.keys(keyHashes).length || Object.values(keyHashes).some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('请配置节点密钥哈希 AGENT_NODE_KEY_A_HASH 等变量。');
  const server = createServer(createCheckHandler({ keyHashes }));
  server.requestTimeout = CHECK_TIMEOUT_MS;
  server.listen(8091, process.env.DESIGN_CHECK_LISTEN_HOST || '127.0.0.1');
}
