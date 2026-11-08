import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../../shared/errors.mjs';
export const staleRoute = () => new AppError('路由表过期，请刷新。', 409, 'STALE_ROUTE');
export const unavailable = reason => new AppError(reason, 503, 'SHARD_UNAVAILABLE');
export const nodeKeyHash = key => createHash('sha256').update(key).digest('hex');
export const nodeHeaders = runtime => ({ 'x-node-id': runtime.nodeId, 'x-node-key': runtime.key });
export function authenticateNode(headers, keyHashes) {
  const nodeId = headers['x-node-id'], key = headers['x-node-key'];
  const expected = keyHashes?.[nodeId];
  if (!['node-a','node-b','node-c'].includes(nodeId) || typeof key !== 'string' || key.length < 24 ||
      !/^[a-f0-9]{64}$/.test(expected || '') || !timingSafeEqual(Buffer.from(nodeKeyHash(key)), Buffer.from(expected)))
    throw new AppError('节点认证失败。', 403, 'NODE_AUTH');
  return nodeId;
}
export function targetOf(route, members) {
  const member = [...members.values()].find(m => m.nodeId === route.primary);
  if (!member) throw unavailable(route.primary ? `分片 ${route.shardId} 的主节点 ${route.primary} 不在线；本章不做故障切换。` : `分片 ${route.shardId} 尚无主节点。`);
  return member.address;
}
export function validateRoute(cache, userId, nodeId, revision) {
  if (!/^\d+$/.test(String(revision)) || cache.routeOf(userId).primary !== nodeId || BigInt(cache.revision) < BigInt(revision)) throw staleRoute();
}
export async function routedRequest({ cache, userId, nodeId, members, local, remote }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const route = cache.routeOf(userId), address = targetOf(route, members);
    try {
      const result = route.primary === nodeId ? await local(route) : await remote(address, route);
      if (result?.status === 409 && result.headers?.get('x-cluster-error') === 'STALE_ROUTE') {
        await result.body?.cancel(); throw staleRoute();
      }
      return result;
    } catch (error) {
      if (error.code !== 'STALE_ROUTE' || attempt === 1) throw error;
      await cache.refresh();
    }
  }
}
const hop = new Set(['host','connection','keep-alive','transfer-encoding','proxy-authenticate','proxy-authorization','te','trailer','upgrade','x-node-key','x-node-id','x-route-revision','x-route-user']);
export function forwardHeaders(headers, key, route, userId) {
  const result = Object.fromEntries(Object.entries(headers).filter(([k]) => !hop.has(k.toLowerCase())));
  Object.assign(result, nodeHeaders(key)); result['x-route-revision'] = route.revision; result['x-route-user'] = userId;
  return result;
}
export async function bufferBody(request) {
  const chunks = []; let size = 0;
  for await (const c of request) { size += c.length; if (size > 512 * 1024) throw new AppError('请求内容过大。', 413); chunks.push(c); }
  return Buffer.concat(chunks);
}
export async function forwardHttp(request, address, route, userId, key, body, { fetcher = fetch, signal } = {}) {
  const sse = request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/events';
  const timeout = sse ? signal : signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const requested = new URL(request.url, 'http://localhost');
  try { return await fetcher(new URL(requested.pathname + requested.search, address), { method: request.method, headers: forwardHeaders(request.headers, key, route, userId),
    body: ['GET','HEAD'].includes(request.method) ? undefined : body, redirect: 'error', signal: timeout }); }
  catch { throw unavailable('分片主节点连接失败或转发超过 30 秒。'); }
}
export async function streamResponse(upstream, response) {
  const headers = Object.fromEntries([...upstream.headers].filter(([k]) => !hop.has(k) && k !== 'content-encoding'));
  response.writeHead(upstream.status, headers); response.flushHeaders?.();
  if (!upstream.body) return response.end();
  await pipeline(Readable.fromWeb(upstream.body), response);
}
