import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const SCRYPT_OPTIONS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
// 格式只接受本章参数；不会从数据库字符串读任意成本参数。
export async function hashPassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('密码不能为空。');
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export const DUMMY_HASH = `scrypt$32768$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
export async function verifyPassword(password, encoded, kdf = derive) {
  const match = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded || '')
    || /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(DUMMY_HASH);
  const actual = await kdf(typeof password === 'string' ? password : '', Buffer.from(match[1], 'hex'), 64, SCRYPT_OPTIONS);
  const equal = timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
  return typeof password === 'string' && Boolean(password) && encoded !== DUMMY_HASH && equal;
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const normalizeUsername = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
