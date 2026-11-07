import { AppError } from '../../../shared/errors.mjs';
import { normalizeUsername } from './password.mjs';

const WINDOW = 15 * 60 * 1000;
export class LoginLimits {
  constructor({ now = Date.now } = {}) { this.now = now; this.buckets = new Map(); }
  keys(username, source) { return [JSON.stringify(['name', normalizeUsername(username), source]), JSON.stringify(['source', source])]; }
  prune() {
    const cutoff = this.now() - WINDOW;
    for (const [key, rows] of this.buckets) {
      const active = rows.filter(row => row.pending || row.time > cutoff);
      if (active.length) this.buckets.set(key, active); else this.buckets.delete(key);
    }
  }
  // 先预占再做异步 scrypt；并发请求不能一起穿过失败次数检查。
  begin(username, source) {
    this.prune();
    const keys = this.keys(username, source), now = this.now();
    for (const [index, key] of keys.entries()) {
      const rows = this.buckets.get(key) || [];
      if (rows.length >= [5, 20][index]) {
        const error = new AppError('登录尝试过于频繁，请稍后重试。', 429, 'RATE_LIMITED');
        error.retryAfter = Math.max(1, Math.ceil((rows[0].time + WINDOW - now) / 1000));
        throw error;
      }
    }
    const entry = { time: now, pending: true };
    for (const key of keys) { const rows = this.buckets.get(key) || []; rows.push(entry); this.buckets.set(key, rows); }
    return success => {
      entry.pending = false; entry.time = this.now();
      if (success) for (const key of keys) {
        const rows = this.buckets.get(key)?.filter(row => row !== entry) || [];
        if (rows.length) this.buckets.set(key, rows); else this.buckets.delete(key);
      }
    };
  }
}
