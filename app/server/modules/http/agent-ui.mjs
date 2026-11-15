import path from 'node:path';
import { readUiFile } from '../agents/ui.mjs';

// 与 Caddy /ui/ 完全一致；测试对照两处，防止只放宽其中一个入口。
export const UI_CSP = "default-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
export function agentUiRoute(request, response, agent) {
  // 必须在 URL 规范化之前检查，避免浏览器/URL 解析器折叠 .. 后丢失越界证据。
  const raw = request.url.split(/[?#]/, 1)[0];
  if (raw !== '/' && !raw.startsWith('/app/')) return false;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': UI_CSP, 'referrer-policy': 'no-referrer' };
  const ui = agent?.definition?.agent.ui;
  if (request.method === 'GET' && raw === '/') {
    response.writeHead(302, { ...headers, location: ui ? '/app/' : '/ui/' }); response.end(); return true;
  }
  if (request.method === 'GET' && ui && raw.startsWith('/app/')) {
    try {
      const relative = raw === '/app/' ? ui.entry : `ui/${decodeURIComponent(raw.slice('/app/'.length))}`;
      const { content, type } = readUiFile(path.dirname(agent.file), relative);
      response.writeHead(200, { ...headers, 'content-type': type }); response.end(content); return true;
    } catch { /* 不向匿名访问者泄露包路径、文件信息或读取失败原因。 */ }
  }
  response.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }); response.end('资源不存在。'); return true;
}
