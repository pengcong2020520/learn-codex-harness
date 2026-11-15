import { createLogRedactor } from '../server/modules/config/index.mjs';

export async function expectStatus(response, status, label, redact = createLogRedactor()) {
  if (response.status === status) return response;
  let body = await response.text();
  // JSON 字段和已知凭据都先脱敏再截断，避免截断后的密钥片段逃过匹配。
  try { body = JSON.parse(body); } catch { /* 代理也可能返回纯文本或 HTML。 */ }
  const contentType = redact(response.headers.get('content-type') || '未提供');
  throw new Error(`${label}：期望 HTTP ${status}，实际 ${response.status}；content-type：${contentType}；响应体前 300 字：${redact(body).slice(0, 300)}`);
}
