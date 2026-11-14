import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resourcePath } from '../data/paths.mjs';
import { AppError } from '../../../shared/errors.mjs';

export const HTML_CSP = "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
export const IMAGE_CSP = "default-src 'none'; img-src 'self'; sandbox";
const types = { html: 'text/html; charset=utf-8', png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };
export const previewMissing = () => new AppError('资源不存在。', 404, 'NOT_FOUND');
export const previewHash = content => createHash('sha256').update(content).digest('hex');
export function previewPath(value) {
  try {
    const locator = resourcePath(value);
    if (!/^(outputs|inputs)\/.+\.(html|png|jpeg|jpg|webp)$/i.test(locator) || !['outputs', 'inputs'].includes(locator.split('/')[0])) throw previewMissing();
    return locator;
  } catch { throw previewMissing(); }
}
function signature(secret, payload) { return createHmac('sha256', secret).update(payload).digest('base64url'); }
export function createPreview(secret, userId, locator, content, now = Date.now()) {
  if (!secret) throw new AppError('缺少 AGENT_PREVIEW_SECRET，请运行 npm run up 补齐配置。', 503);
  const expiresAt = now + 10 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ userId, path: previewPath(locator), expiresAt, sha256: previewHash(content) })).toString('base64url');
  return { url: `/preview/${payload}.${signature(secret, payload)}`, expiresAt };
}
export function verifyPreview(secret, token, now = Date.now()) {
  try {
    if (!secret || typeof token !== 'string' || token.length > 4096 || !/^[\w-]+\.[\w-]{43}$/.test(token)) throw previewMissing();
    const [payload, mac] = token.split('.');
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(signature(secret, payload)))) throw previewMissing();
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!/^[a-f0-9-]{36}$/.test(claim.userId || '') || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= now || !/^[a-f0-9]{64}$/.test(claim.sha256 || '')) throw previewMissing();
    previewPath(claim.path);
    return claim;
  } catch { throw previewMissing(); }
}
export function previewHeaders(locator) {
  const extension = locator.split('.').at(-1).toLowerCase();
  return { 'content-type': types[extension], 'content-security-policy': extension === 'html' ? HTML_CSP : IMAGE_CSP,
    'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };
}
