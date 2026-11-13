import { AppError } from '../../../shared/errors.mjs';

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['http://127.0.0.1:4317', 'http://localhost:4317']);
export function allowedOrigins(environment) {
  const port = environment.AGENT_PORT || 4317;
  const value = environment.AGENT_ALLOWED_ORIGINS?.trim() || `http://127.0.0.1:${port},http://localhost:${port}`;
  return Object.freeze([...new Set(value.split(',').map(entry => {
    const origin = entry.trim();
    try {
      const url = new URL(origin);
      // Reject paths (including /), credentials and empty/invalid ports; store the
      // canonical origin that browsers send (including normalised default ports).
      if (!/^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[^:/?#\\\s@]+)(?::[0-9]+)?$/.test(origin) || url.username || url.password || !url.hostname || /[\u0000-\u0020\u007f]/.test(origin))
        throw new Error();
      return url.origin;
    } catch { throw new Error('AGENT_ALLOWED_ORIGINS 必须是逗号分隔的完整 http(s) origin，不能包含路径、凭据或查询参数。'); }
  }))]);
}
export function assertAllowedOrigin(headers, config) {
  if (headers.origin !== undefined && !(config?.allowedOrigins || DEFAULT_ALLOWED_ORIGINS).includes(headers.origin))
    throw new AppError('不允许的来源。网页访问请把入口地址加入 AGENT_ALLOWED_ORIGINS。', 403);
}
