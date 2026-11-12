import { randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors.mjs';
import { verifyPassword, tokenHash, normalizeUsername, DUMMY_HASH } from './password.mjs';
import { LoginLimits } from './limits.mjs';

export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const IDLE_MS = 12 * 60 * 60 * 1000;
export const TOUCH_MS = 60 * 1000;
export const unauthorized = () => new AppError('请运行 npm run login 重新登录。', 401, 'UNAUTHENTICATED');
export const publicUser = user => ({ id: user.id, username: user.username, role: user.role });
export class Accounts {
  constructor(store, { now = Date.now, verify = verifyPassword, limits = new LoginLimits({ now }) } = {}) {
    Object.assign(this, { store, now, verify, limits });
  }
  async login({ username, password }, source, clientHint = 'CLI') {
    const finish = this.limits.begin(username, source);
    let success = false;
    try {
      const user = await this.store.byUsername(normalizeUsername(username));
      const valid = await this.verify(password, user?.password_hash || DUMMY_HASH);
      if (!valid || !user || user.disabled_at) throw new AppError('用户名或密码错误。', 401, 'LOGIN_FAILED');
      const token = randomBytes(32).toString('base64url');
      const now = this.now(), expiresAt = new Date(now + ABSOLUTE_MS).toISOString();
      // 再锁定用户并核对哈希，避免改密码/禁用与登录并发时签出旧凭证。
      const saved = await this.store.createSession(user, { id: randomUUID(), userId: user.id, tokenHash: tokenHash(token),
        createdAt: new Date(now), expiresAt, clientHint });
      if (!saved) throw new AppError('用户名或密码错误。', 401, 'LOGIN_FAILED');
      success = true;
      return { token, expiresAt, user: publicUser(user) };
    } finally { finish(success); }
  }
  async authenticate(authorization) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization || '');
    if (!match) throw unauthorized();
    const row = await this.store.session(tokenHash(match[1]));
    const now = this.now();
    if (!row || row.disabled_at || row.revoked_at || now >= +new Date(row.expires_at)
      || now - +new Date(row.created_at) >= ABSOLUTE_MS || now - +new Date(row.last_seen_at) >= IDLE_MS) throw unauthorized();
    if (now - +new Date(row.last_seen_at) >= TOUCH_MS) await this.store.touch(row.session_id, new Date(now));
    return { userId: row.id, role: row.role, authSessionId: row.session_id, authorization, user: publicUser(row) };
  }
  async logout(identity) { await this.store.revokeAll(identity.userId); }
}
