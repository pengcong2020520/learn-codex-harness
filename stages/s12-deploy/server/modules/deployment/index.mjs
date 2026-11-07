import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../../../shared/errors.mjs';

export function deploymentConfig(env = {}) {
  const integer = (key, fallback) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须为正整数。`);
    return value;
  };
  return {
    maxConcurrentTurns: integer('AGENT_MAX_CONCURRENT_TURNS', 2),
    maxQueued: integer('AGENT_MAX_QUEUED', 200),
    rateLimit: integer('AGENT_RATE_LIMIT_PER_MINUTE', 120),
    maxSse: integer('AGENT_MAX_SSE', 20),
  };
}
export function revision(root) {
  if (!root) return 'dev';
  try { return readFileSync(path.join(root, 'REVISION'), 'utf8').trim() || 'dev'; }
  catch (error) { if (error.code === 'ENOENT') return 'dev'; throw error; }
}
export function createReadiness({ config, data, messages, tools, fetcher = fetch, stopping = () => false }) {
  const version = revision(config.root);
  return async () => {
    const checks = { database: false, gateway: false, models: Boolean(config.registry && config.launch.router && config.launch.catalog?.models?.length) };
    try { await data.pool.query({ text: 'SELECT 1', query_timeout: 3000 }); checks.database = true; } catch { /* No credentials in responses. */ }
    try {
      const url = new URL('/health', config.media.endpoint.baseUrl);
      checks.gateway = (await fetcher(url, { signal: AbortSignal.timeout(3000) })).ok;
    } catch { /* Gateway health does not call a model. */ }
    const ready = Object.values(checks).every(Boolean) && !stopping() && !messages.failure && !messages.closed && !messages.stopping && !tools?.broken && data.queue?.healthy !== false;
    return { status: ready ? 'ready' : 'not-ready', version, checks };
  };
}

// Sliding 60-second window, keyed by the actual socket peer; never trust X-Forwarded-For.
export class RequestLimits {
  constructor({ rateLimit = 120, maxSse = 20, now = Date.now } = {}) {
    Object.assign(this, { rateLimit, maxSse, now });
    this.windows = new Map();
    this.sse = 0;
  }
  request(token, address) {
    const now = this.now();
    for (const [key, values] of this.windows) {
      while (values.length && values[0] <= now - 60000) values.shift();
      if (!values.length) this.windows.delete(key);
    }
    const key = createHash('sha256').update(`${token}\0${address}`).digest('hex');
    const values = this.windows.get(key) || [];
    if (values.length >= this.rateLimit) {
      const error = new AppError('请求过于频繁。', 429, 'RATE_LIMITED');
      error.retryAfter = Math.max(1, Math.ceil((values[0] + 60000 - now) / 1000));
      throw error;
    }
    values.push(now);
    this.windows.set(key, values);
  }
  acquireSse() {
    if (this.sse >= this.maxSse) {
      const error = new AppError('SSE 连接已满。', 429, 'SSE_FULL');
      error.retryAfter = 5;
      throw error;
    }
    this.sse++;
    let released = false;
    return () => { if (!released) { released = true; this.sse--; } };
  }
}

// Stop dispatch synchronously, persist uncertain tasks, then tear down resources.
export function gracefulShutdown({ stopDispatch, markUnconfirmed, close, exit = code => process.exit(code), timer = setTimeout, clear = clearTimeout }) {
  let pending;
  return () => pending ||= (async () => {
    stopDispatch();
    const deadline = timer(() => exit(1), 30000);
    try { await markUnconfirmed(); await close(); }
    finally { clear(deadline); }
  })();
}
