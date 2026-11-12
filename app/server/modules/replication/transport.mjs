import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../../../shared/errors.mjs';

export function replicationRateLimit(env = process.env) {
  const raw = env.AGENT_REPLICATION_RATE_LIMIT ?? '0';
  const rate = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(rate)) throw new Error('AGENT_REPLICATION_RATE_LIMIT 必须为非负安全整数（字节/秒）。');
  return rate;
}

// One instance per node, shared by every destination; no initial burst allowance.
export class ReplicationRateLimiter {
  constructor(rate, { now = () => performance.now(), sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    this.rate = replicationRateLimit({ AGENT_REPLICATION_RATE_LIMIT: rate });
    this.now = now; this.sleep = sleep; this.next = 0;
    this.chunkSize = this.rate ? Math.max(1, Math.min(65536, Math.floor(this.rate / 10))) : 65536;
  }
  async take(bytes, signal) {
    signal?.throwIfAborted();
    if (!this.rate || !bytes) return;
    const now = this.now();
    this.next = Math.max(now, this.next) + bytes * 1000 / this.rate;
    await this.sleep(Math.ceil(this.next - now), signal);
    signal?.throwIfAborted();
  }
}

export function progressTimeout({ signal, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController();
  let timer;
  const abort = () => controller.abort(signal.reason);
  const progress = () => {
    clearTimer(timer);
    timer = setTimer(() => controller.abort(new Error('复制发送连续 30 秒无字节进展。')), 30000);
    timer.unref?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  progress();
  return { signal: controller.signal, progress, abort: reason => controller.abort(reason), close() { clearTimer(timer); signal?.removeEventListener('abort', abort); } };
}

// Await each socket write callback: reading/prefetching a file is not network progress.
export async function sendArchive(url, file, { headers, limiter, signal } = {}) {
  const watchdog = progressTimeout({ signal });
  let request, input;
  try {
    watchdog.signal.throwIfAborted();
    request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'PUT', headers, signal: watchdog.signal,
    });
    const response = new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', async res => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
            throw new AppError(value?.error?.message || '从节点拒绝复制目录。', res.statusCode, value?.error?.code);
          }
          resolve();
        } catch (error) { reject(error); }
      });
    });
    // Early rejection must also stop a body blocked on the limiter or socket.
    const failed = response.catch(error => { watchdog.abort(error); request.destroy(error); throw error; });
    failed.catch(() => {});
    input = fs.createReadStream(file, { highWaterMark: limiter.chunkSize, signal: watchdog.signal });
    const upload = async () => {
      for await (const chunk of input) {
        await limiter.take(chunk.length, watchdog.signal);
        await new Promise((resolve, reject) => request.write(chunk, error => {
          if (error) reject(error);
          else { watchdog.progress(); resolve(); }
        }));
      }
      request.end();
    };
    await Promise.all([upload(), failed]);
  } finally {
    watchdog.abort(new Error('复制请求结束。')); watchdog.close(); input?.destroy(); request?.destroy();
  }
}
