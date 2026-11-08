import { logFailure } from '../data/diagnostics.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { runIdentity, runOwner } from '../accounts/context.mjs';
import { withShardUser } from './fence.mjs';
import { authenticateNode, validateRoute, routedRequest, forwardHttp, bufferBody, streamResponse, targetOf, unavailable } from './routing.mjs';
import { moveUser } from './move.mjs';
import { exportTree, importTree } from './transfer.mjs';
import { prepareDirectories } from '../runtimes/directories.mjs';
import { RuntimeStore } from '../runtimes/store.mjs';
import { AppError } from '../../../shared/errors.mjs';

export function installInternalClient(runtime) {
  runtime.call = async (address, pathname, body) => {
    const response = await fetch(new URL(pathname, address), { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-node-key': runtime.key }, body: JSON.stringify(body), signal: ['/internal/move','/internal/copy'].includes(pathname) ? undefined : AbortSignal.timeout(30000) });
    const value = await response.json();
    if (!response.ok) throw new AppError(value.error?.message || '节点调用失败。', response.status, value.error?.code);
    return value;
  };
}
const parse = async req => { try { return JSON.parse((await bufferBody(req)).toString()); } catch (e) { throw new AppError(e.message, 400); } };
const nodeAddress = (runtime, id) => targetOf({ primary: id }, runtime.coordination.members);
async function ownerForRequest(app, request, identity, body) {
  const url = new URL(request.url, 'http://localhost');
  const match = url.pathname.match(/^\/hub\/(knowledge|skills)\/([^/]+)/);
  let type, id;
  if (match) { type = match[1] === 'knowledge' ? 'knowledge_bases' : 'hub_skills'; id = decodeURIComponent(match[2]); }
  if (request.method !== 'GET' && url.pathname.startsWith('/knowledge') && url.pathname !== '/knowledge/search') {
    type = 'knowledge_bases'; id = url.pathname.match(/^\/knowledge\/([^/]+)$/)?.[1];
    if (request.method === 'POST' && body?.length) { try { id = JSON.parse(body).kbId; } catch {} }
  }
  if (type && id) {
    const row = (await app.data.pool.query(`SELECT owner_id FROM agent_data.${type} WHERE instance_id=$1 AND id=$2`, [app.data.scope.instanceId, id])).rows[0];
    if (row) return row.owner_id;
  }
  return identity.userId;
}
export async function shardStatus(coordination, cache, app, runtime) {
  const base = await coordination.status();
  const counts = (await app.data.pool.query(`SELECT s.node_id,count(*)::int AS users FROM agent_data.user_shards u JOIN agent_data.shard_owners s USING(shard_id) JOIN agent_data.users a ON a.id=u.user_id WHERE a.instance_id=$1 AND a.username IS NOT NULL GROUP BY s.node_id`, [app.data.scope.instanceId])).rows;
  const nodes = [...new Set(['node-a','node-b','node-c', ...base.members.map(m => m.nodeId)])];
  const revisions = Object.fromEntries(nodes.map(id => [id, null]));
  await Promise.all(base.members.map(async member => {
    try { revisions[member.nodeId] = member.nodeId === runtime.nodeId ? cache.revision : (await runtime.call(member.address, '/internal/revision', {})).revision; }
    catch { revisions[member.nodeId] = null; }
  }));
  const online = new Set(base.members.map(m => m.nodeId));
  return { ...base, shards: Object.entries(cache.shards).map(([shardId, owner]) => ({ shardId, ...owner, status: online.has(owner.primary) ? 'available' : 'unavailable' })),
    slots: cache.slots, slotDistribution: Object.fromEntries(['0','1','2'].map(s => [s, Object.values(cache.slots).filter(x => x === s).length])),
    usersPerNode: Object.fromEntries(nodes.map(id => [id, counts.find(c => c.node_id === id)?.users || 0])), routeRevisions: revisions };
}
export function createShardedHandler(coordination, service, runtime, control) {
  installInternalClient(runtime);
  runtime.copies ||= new Map(); runtime.transfers ||= new Map();
  const exclusive = async (map, userId, operation) => {
    if (map.has(userId)) throw new AppError('该用户仍有迁移传输未结束。', 409);
    const pending = operation(); map.set(userId, pending);
    try { return await pending; } finally { map.delete(userId); }
  };
  const recordFor = async userId => {
    if (!/^[a-f0-9-]{36}$/.test(userId || '')) throw new AppError('无效用户 ID。', 400);
    const app = service.app;
    return (await app.data.pool.query('SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2', [app.data.scope.instanceId, userId])).rows[0];
  };
  const paused = async userId => {
    const row = (await service.app.data.pool.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1', [userId])).rows[0];
    if (!row?.paused) throw new AppError('迁移要求先持久化暂停用户。', 409);
  };
  async function internal(req, res, pathname, json) {
    authenticateNode(req.headers, runtime.key);
    if (pathname === '/internal/revision') return json(200, { revision: runtime.cache.revision });
    const url = new URL(req.url, 'http://localhost');
    const app = service.app;
    if (pathname === '/internal/transfer' && req.method === 'PUT') {
      const userId = url.searchParams.get('user'), kind = url.searchParams.get('kind');
      await paused(userId);
      if (runtime.owns(userId)) throw new AppError('不能覆盖仍在负责的用户目录。', 409);
      const record = await recordFor(userId);
      if (!record) throw new AppError('源运行环境映射缺失。', 409);
      return json(200, await exclusive(runtime.transfers, userId, () => importTree(app.config.root, record, kind, req, async () => {
        app.config.generation?.assert(); await paused(userId);
        if (runtime.owns(userId)) throw new AppError('目标已开始负责用户，拒绝迟到目录。', 409);
      })));
    }
    const body = await parse(req);
    if (pathname === '/internal/knowledge') return json(200, await runtime.readKnowledge(body));
    if (pathname === '/internal/ensure-user') { await control.ensureUser(body.userId); return json(200, { assigned: true }); }
    if (pathname === '/internal/move') {
      // Reauthenticate admin at control; possession of a node key is not an admin credential.
      const identity = await app.accounts.authenticate(body.authorization);
      if (identity.role !== 'admin') throw new AppError('需要 admin。', 403);
      return json(200, await executeMove(body.username, body.shardId));
    }
    if (!['/internal/pause','/internal/drain','/internal/copy','/internal/resume'].includes(pathname)) throw new AppError('内部接口不存在。', 404);
    const { userId } = body;
    await paused(userId);
    if (pathname === '/internal/resume') {
      await runtime.copies.get(userId)?.catch(() => {});
      await runtime.transfers.get(userId)?.catch(() => {});
      await runtime.cache.refresh(); runtime.paused.delete(userId); return json(200, { resumed: true });
    }
    if (!runtime.owns(userId)) throw unavailable('源节点已不是用户主节点。');
    if (pathname === '/internal/pause') {
      runtime.paused.add(userId);
      await app.sessions.atBoundary(async () => {}); // waits for any queued->starting admission already in progress
      app.http.closeUserStreams?.(userId);
      return json(200, { paused: true });
    }
    if (!runtime.paused.has(userId)) throw new AppError('源节点尚未暂停。', 409);
    if (pathname === '/internal/drain') {
      await app.runtimes.waitSkills?.(userId);
      await app.usage.pending;
      const busy = (await app.data.pool.query(`SELECT EXISTS(SELECT 1 FROM agent_data.tasks t JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id WHERE c.instance_id=$1 AND c.owner_id=$2 AND t.status IN ('starting','running','steering')) OR EXISTS(SELECT 1 FROM agent_data.media_jobs WHERE instance_id=$1 AND owner_id=$2 AND status NOT IN ('completed','failed')) OR EXISTS(SELECT 1 FROM agent_data.knowledge_jobs j JOIN agent_data.knowledge_bases k ON k.instance_id=j.instance_id AND k.id=j.kb_id WHERE j.instance_id=$1 AND k.owner_id=$2 AND j.state='running') AS busy`, [app.data.scope.instanceId, userId])).rows[0].busy;
      const entry = app.runtimes.pool.entries.get(userId);
      if (busy || entry?.refs || runtime.inflight?.get(userId)) return json(200, { drained: false });
      if (entry) await app.runtimes.pool.remove(entry);
      await app.usage.pending;
      // Source creates an empty runtime mapping/tree if the user has never logged in.
      await runOwner(userId, async () => {
        const record = await new RuntimeStore(app.data.pool, app.data.scope.instanceId, app.config.root).ensure(userId);
        prepareDirectories(app.config.root, record, { isolated: process.getuid() === 0 });
      });
      return json(200, { drained: true });
    }
    if (pathname === '/internal/copy') {
      return json(200, await exclusive(runtime.copies, userId, async () => {
      const record = await recordFor(userId), address = nodeAddress(runtime, body.target);
      for (const kind of ['home','workspace']) {
        app.config.generation?.assert();
        const tar = exportTree(app.config.root, record, kind);
        try {
        const response = await fetch(new URL(`/internal/transfer?user=${userId}&kind=${kind}`, address), { method: 'PUT', headers: { 'x-node-key': runtime.key }, body: tar.stream, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(30000) });
        await tar.done;
        if (!response.ok) throw new Error('目标节点拒绝用户目录。');
        await response.arrayBuffer();
        } finally { await tar.stop(); }
      }
      await copyContent(app, runtime, userId, address);
      return { copied: true };
      }));
    }
  }
  async function executeMove(username, shardId) {
    coordination.assertController();
    const app = service.app;
    const user = await app.accounts.store.byUsername(username);
    if (!user) throw new AppError('用户不存在。', 404);
    const db = await control.pool.connect();
    try {
      // Session lock covers copying without holding a SQL transaction open for a long turn.
      const { rows } = await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,17)) AS locked', [user.id]);
      if (!rows[0].locked) throw new AppError('此用户正在迁移。', 409);
      try {
        return await moveUser({ userId: user.id, shardId, control, cache: runtime.cache,
          pause: (node, userId) => runtime.call(nodeAddress(runtime, node), '/internal/pause', { userId }),
          drain: async (node, userId) => {
            while (!(await runtime.call(nodeAddress(runtime, node), '/internal/drain', { userId })).drained) { coordination.assertController(); await delay(200); }
          },
          copy: (source, target, userId) => runtime.call(nodeAddress(runtime, source), '/internal/copy', { target, userId }),
          resume: (node, userId) => runtime.call(nodeAddress(runtime, node), '/internal/resume', { userId }),
        });
      } finally { await db.query('SELECT pg_advisory_unlock(hashtextextended($1,17))', [user.id]); }
    } finally { db.release(); }
  }
  return async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store', ...(value.error?.code ? { 'x-cluster-error': value.error.code } : {}) }); response.end(JSON.stringify(value)); };
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/health') return json(200, { status: 'alive' });
      if (!service.isReady()) throw unavailable('节点未就绪或成员租约失效。');
      if (pathname === '/ready') return service.app.http.handle(request, response);
      if (pathname === '/internal/content') {
        authenticateNode(request.headers, runtime.key);
        const userId = new URL(request.url, 'http://localhost').searchParams.get('user');
        return await exclusive(runtime.transfers, userId, () => receiveContent(service.app, request, json, paused));
      }
      if (pathname.startsWith('/internal/')) return await internal(request, response, pathname, json);
      if (request.headers.origin !== undefined) throw new AppError('CLI only', 403);
      if (pathname === '/auth/login') return service.app.http.handle(request, response);
      const identity = await service.app.accounts.authenticate(request.headers.authorization);
      if (pathname === '/cluster' || pathname === '/cluster/move') {
        if (identity.role !== 'admin') throw new AppError('需要 admin。', 403);
        if (pathname === '/cluster') return json(200, await shardStatus(coordination, runtime.cache, service.app, runtime));
        if (request.method !== 'POST') throw new AppError('需要 POST。', 405);
        const body = await parse(request);
        const result = coordination.isController() ? await executeMove(body.username, body.shardId)
          : await runtime.call(nodeAddress(runtime, (await coordination.observeControl())?.nodeId), '/internal/move', { ...body, authorization: request.headers.authorization });
        return json(200, result);
      }
      if (pathname.startsWith('/auth/')) return service.app.http.handle(request, response);
      const body = ['GET','HEAD'].includes(request.method) ? undefined : await bufferBody(request);
      const owner = await ownerForRequest(service.app, request, identity, body);
      const mapping = (await service.app.data.pool.query('SELECT 1 FROM agent_data.user_shards WHERE user_id=$1', [owner])).rows[0];
      if (!mapping) {
        if (coordination.isController()) await control.ensureUser(owner);
        else await runtime.call(nodeAddress(runtime, (await coordination.observeControl())?.nodeId), '/internal/ensure-user', { userId: owner });
      }
      const forwarded = request.headers['x-node-key'] !== undefined;
      if (forwarded) {
        authenticateNode(request.headers, runtime.key);
        if (request.headers['x-route-user'] !== owner) throw new AppError('转发用户不匹配。', 403);
        validateRoute(runtime.cache, owner, runtime.nodeId, request.headers['x-route-revision']);
      }
      const local = async () => {
        await runtime.admit(owner);
        const incoming = body === undefined ? request : Object.assign(Readable.from([body]), { url: request.url, method: request.method, headers: request.headers, socket: request.socket });
        runtime.inflight ||= new Map(); runtime.inflight.set(owner, (runtime.inflight.get(owner) || 0) + 1);
        try { await withShardUser(owner, () => service.app.http.handle(incoming, response)); }
        finally { runtime.inflight.set(owner, runtime.inflight.get(owner) - 1); }
      };
      if (forwarded) return await local();
      const abort = new AbortController(); const close = () => abort.abort(); response.once('close', close);
      try {
        const result = await routedRequest({ cache: runtime.cache, userId: owner, nodeId: runtime.nodeId, members: coordination.members, local,
          remote: (address, route) => forwardHttp(request, address, route, owner, runtime.key, body, { signal: abort.signal }) });
        if (result) await streamResponse(result, response);
      } finally { response.off('close', close); }
    } catch (error) {
      if (!error.status || error.status >= 500) logFailure(error, service.app?.config?.generation || { nodeId: runtime.nodeId }, error, '', 'HTTP');
      if (!response.headersSent) json(error.status || 503, { error: { code: error.code || 'UNAVAILABLE', message: error.status ? error.message : '节点操作失败，请查看服务日志。' } });
      else response.destroy();
    }
  };
}
// Immutable auxiliary blobs/indexes must move too; only rows owned by this user select filenames.
async function contentFiles(app, userId) {
  const rows = (await app.data.pool.query(`SELECT v.blob AS file,'blob' AS kind,v.revision AS digest FROM agent_data.resource_versions v JOIN agent_data.resources r ON r.instance_id=v.instance_id AND r.id=v.resource_id WHERE r.instance_id=$1 AND r.owner_id=$2
    UNION SELECT v.blob,'blob',v.revision FROM agent_data.wiki_versions v JOIN agent_data.knowledge_bases k ON k.instance_id=v.instance_id AND k.id=v.kb_id WHERE k.instance_id=$1 AND k.owner_id=$2
    UNION SELECT i.revision::text || '.json','index',i.manifest->>'bm25Hash' FROM agent_data.knowledge_indexes i JOIN agent_data.knowledge_bases k ON k.instance_id=i.instance_id AND k.id=i.kb_id WHERE k.instance_id=$1 AND k.owner_id=$2 AND i.state='ready'`, [app.data.scope.instanceId, userId])).rows;
  return rows;
}
function contentPath(root, kind, file) {
  if (!(kind === 'blob' ? /^[a-f0-9]{64}\.(txt|bin)$/ : /^[a-f0-9-]{36}\.json$/).test(file)) throw new Error('无效内容文件。');
  return path.join(root, kind === 'blob' ? '.data/files/objects' : '.data/knowledge/bm25', file);
}
async function copyContent(app, runtime, userId, address) {
  for (const { file, kind } of await contentFiles(app, userId)) {
    const target = contentPath(app.config.root, kind, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('不安全的内容文件。');
    const response = await fetch(new URL(`/internal/content?user=${userId}&kind=${kind}&file=${file}`, address), { method:'PUT', headers: { 'x-node-key': runtime.key }, body:fs.createReadStream(target), duplex:'half', redirect:'error', signal:AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('内容文件迁移失败。'); await response.arrayBuffer();
  }
}
async function receiveContent(app, req, json, paused) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  await paused(q.get('user'));
  const entry = (await contentFiles(app, q.get('user'))).find(r => r.file === q.get('file') && r.kind === q.get('kind'));
  if (!entry) throw new AppError('未授权的用户内容。',403);
  const target = contentPath(app.config.root,q.get('kind'),q.get('file'));
  fs.mkdirSync(path.dirname(target), { recursive:true, mode:0o700 });
  const temp = target + '.moving';
  const hash = createHash('sha256');
  try {
    await pipeline(req, new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } }), fs.createWriteStream(temp, { flags:'wx',mode:0o600 }));
    if (hash.digest('hex') !== entry.digest) throw new Error('迁移内容校验失败。');
    app.config.generation?.assert(); await paused(q.get('user'));
    fs.renameSync(temp,target);
  }
  finally { fs.rmSync(temp,{force:true}); }
  return json(200,{ copied:true });
}
