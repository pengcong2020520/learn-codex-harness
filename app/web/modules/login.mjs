// 回跳只用于同源 Agent 前端；同时检查原始值和解码后的路径，拒绝 URL 规范化绕过。
export function loginNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/app/')) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\%\u0000-\u0020\u007f]/.test(decoded)) return null;
    const pathname = decoded.split(/[?#]/, 1)[0];
    if (pathname.split('/').some(part => part === '.' || part === '..')) return null;
    const base = 'https://agent.example.com';
    const target = new URL(value, base);
    return target.origin === base && target.pathname.startsWith('/app/') ? value : null;
  } catch { return null; }
}
