import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Accounts } from '../server/modules/accounts/index.mjs';
import { hashPassword } from '../server/modules/accounts/password.mjs';
import { createHttpService } from '../server/modules/http/index.mjs';
import { EventHub } from '../server/modules/events/index.mjs';

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
export class MemoryAccounts {
  users = []; sessions = []; touches = 0;
  async byUsername(name) { return this.users.find(user => user.username === name); }
  async createSession(user, session) {
    if (user.disabled_at) return false;
    this.sessions.push({ session_id: session.id, user_id: session.userId, token_hash: session.tokenHash,
      created_at: session.createdAt, last_seen_at: session.createdAt, expires_at: session.expiresAt, revoked_at: null });
    return true;
  }
  async session(hash) {
    const session = this.sessions.find(row => row.token_hash === hash);
    if (!session) return;
    return { ...this.users.find(user => user.id === session.user_id), ...session };
  }
  async touch(id, now) { this.touches++; this.sessions.find(row => row.session_id === id).last_seen_at = now; }
  async revokeAll(id) { for (const row of this.sessions) if (row.user_id === id) row.revoked_at = new Date(); }
}
export async function accountFixture(options = {}) {
  const store = new MemoryAccounts();
  const hash = await hashPassword('fixture-password');
  store.users.push({ id: OWNER_A, username: 'alice', password_hash: hash, role: 'admin' },
    { id: OWNER_B, username: 'bob', password_hash: hash, role: 'user' });
  const accounts = new Accounts(store, options);
  return { accounts, store };
}
export class Response extends EventEmitter {
  headers = {}; chunks = []; writableLength = 0;
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); this.headersSent = true; }
  flushHeaders() {}
  write(chunk) { this.chunks.push(chunk); }
  end(body) { if (body) this.body = JSON.parse(body); this.destroyed = true; this.emit('close'); }
  destroy() { this.end(); }
}
export async function request(http, url, { token, body, source = 'peer', method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  const response = new Response();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, socket: { remoteAddress: source } });
  await http.handle(req, response);
  return response;
}
export function httpFixture(accounts, extra = {}) {
  return createHttpService({ accounts, config: { launch: {}, deployment: {} }, sessions: {}, messages: {},
    redact: JSON.stringify, hub: new EventHub({ warn: () => {} }), readiness: async () => ({ status: 'ready' }), ...extra });
}

export function fixedAccounts(token = 'unit-token') {
  return { async authenticate(header) {
    if (header !== `Bearer ${token}`) throw Object.assign(new Error('请重新登录。'), { status: 401, code: 'UNAUTHENTICATED' });
    return { userId: OWNER_A, role: 'admin', authSessionId: 'fixture', user: { id: OWNER_A, username: 'fixture', role: 'admin' } };
  } };
}
