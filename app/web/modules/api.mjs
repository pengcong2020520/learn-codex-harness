import { parseSse, sseState } from './sse.mjs';

export function apiError(status, body = {}, retryAfter, now = Date.now()) {
  const seconds = retryAfter == null ? null : /^\d+$/.test(String(retryAfter).trim())
    ? Number(retryAfter) : Math.max(0, Math.ceil((Date.parse(retryAfter) - now) / 1000));
  const wait = Number.isFinite(seconds) ? seconds : null;
  const defaults = { 401: '登录已失效，请重新登录。', 403: '没有权限执行此操作。', 429: '请求过于频繁，请稍后再试。', 503: '服务暂时不可用，请稍后再试。' };
  const message = status === 401 && body.error?.code !== 'LOGIN_FAILED' ? defaults[401]
    : body.error?.message || defaults[status] || `请求失败（HTTP ${status}）。`;
  const prefix = [429, 503].includes(status) && !message.includes(defaults[status]) ? `${defaults[status]} ` : '';
  return Object.assign(new Error(prefix + message + (wait !== null && [429, 503].includes(status) ? ` 请等待 ${wait} 秒。` : '')), { status, retryAfter: wait });
}
export function createApi({ getToken, onUnauthorized, fetcher = fetch }) {
  async function response(route, { body, signal, stream = false, raw = false, contentType } = {}) {
    const result = await fetcher(route, {
      method: raw ? 'PUT' : body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
      headers: { Authorization: `Bearer ${getToken() || ''}`, ...(body === undefined ? {} : { 'Content-Type': raw ? contentType : 'application/json' }) },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }), signal: signal || AbortSignal.timeout(30000)
    });
    if (!result.ok) {
      if (result.status === 401) onUnauthorized();
      const data = await result.json().catch(() => ({}));
      throw apiError(result.status, data, result.headers.get('Retry-After'));
    }
    return stream ? result : result.json();
  }
  return {
    upload: (path, file, contentType) => response(`/workspace/files?path=${encodeURIComponent(path)}`, { body: file, raw: true, contentType }),
    request: (route, body, signal) => response(route, { body, signal }),
    subscribe(threadId, onEvent, onStatus) {
      const controller = new AbortController(); let attempt;
      const done = (async () => {
        while (!controller.signal.aborted) {
          attempt = new AbortController();
          const signal = AbortSignal.any([controller.signal, attempt.signal]);
          try {
            // Deliberately omit Last-Event-ID on reconnect: the server sends an authoritative
            // snapshot first. This also repairs delta gaps and node failover event histories.
            const result = await response(`/events?threadId=${encodeURIComponent(threadId)}`, { signal, stream: true });
            const reader = result.body.getReader(), decoder = new TextDecoder(); let state = sseState();
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) throw new Error('事件连接中断。');
                const parsed = parseSse(state, decoder.decode(value, { stream: true })); state = parsed.state;
                for (const frame of parsed.events) {
                  if (signal.aborted) break;
                  const event = JSON.parse(frame.data);
                  onEvent(event);
                  if (event.type === 'snapshot' && !signal.aborted) onStatus('connected');
                }
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          } catch (error) {
            if (controller.signal.aborted || error.status === 401) break;
            if (attempt.signal.aborted) continue;
            onStatus('reconnecting', error.status ? error.message : '');
            await new Promise(resolve => {
              const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
              const timer = setTimeout(finish, 1000);
              controller.signal.addEventListener('abort', finish, { once: true });
            });
          }
        }
      })();
      return { close: () => controller.abort(), resync: () => attempt?.abort(), done };
    }
  };
}
