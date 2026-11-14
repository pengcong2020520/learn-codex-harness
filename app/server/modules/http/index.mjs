import { createPreview, verifyPreview, previewPath, previewHash, previewHeaders, previewMissing, previewRateChecked } from './previews.mjs';
import { assertAllowedOrigin } from "../config/origins.mjs";
import { logFailure } from '../data/diagnostics.mjs';
import { shardUser } from '../sharding/fence.mjs';
import { hubRoute } from '../hub/routes.mjs';
import { RequestLimits, createReadiness, revision } from "../deployment/index.mjs";
import { createServer } from "node:http";
import { runIdentity } from "../accounts/context.mjs";
import { AppError } from "../../../shared/errors.mjs";
import { SESSION_EVENT_TYPES } from "../../../shared/session-events.mjs";

const BODY_LIMIT = 512 * 1024;
async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) throw new AppError("请求需要 application/json。", 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new AppError("请求内容过大。", 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  }
  catch { throw new AppError("JSON 格式不正确。"); }
}

// HTTP 是客户端的入口；业务逻辑全部交给 sessions / messages 模块。
export function createHttpService({ config, accounts, sessions, messages, hub, redact, tools, memory, data, resources, gate, knowledge, files, permissionHub, usage = sessions.usage, readiness, log = console.error }) {
  const limits = new RequestLimits(config.deployment);
  const ready = readiness || createReadiness({ config, data, messages, tools });
  const version = revision(config.root);
  const streams = new Set();
  // 同一个事件推给多个 SSE 连接时，只序列化、脱敏一次。
  const encoded = new WeakMap();
  const encode = event => {
    let text = encoded.get(event);
    if (text === undefined) encoded.set(event, text = redact(event));
    return text;
  };
  const handle = async (request, response) => {
    const json = (status, data) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(redact(data));
    };
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      assertAllowedOrigin(request.headers, config);
      if (request.method === 'GET' && pathname === '/health') return json(200, { status: 'alive', version });
      if (request.method === 'GET' && pathname === '/ready') {
        const result = await ready();
        const replication = await config.sharding?.replication?.status();
        if (replication?.waiting) { result.status = 'not-ready'; result.waiting = replication.waiting; }
        if (replication?.replication) result.replication = replication.replication;
        if (replication?.shards.some(s => s.replica_lagging)) result.degraded = { replica_lagging: replication.shards.filter(s => s.replica_lagging).map(s => s.shardId) };
        return json(result.status === 'ready' ? 200 : 503, result);
      }
      config.generation?.assert();
      const source = request.socket?.remoteAddress || 'unknown';
      if (request.method === 'POST' && pathname === '/auth/login') {
        limits.request(null, source);
        const result = await accounts.login(await readBody(request), source, request.headers.origin ? "Web" : "CLI");
        // 令牌只交付给登录者；不要把认证响应交给日志脱敏器或日志输出。
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(JSON.stringify(result));
        return;
      }
      const preview = request.method === 'GET' && pathname.startsWith('/preview/');
      let claim;
      if (preview) {
        if (!request[previewRateChecked]) limits.request(null, source);
        claim = verifyPreview(config.previewSecret, pathname.slice('/preview/'.length));
      }
      let identity;
      try { identity = preview ? { userId: claim.userId } : await accounts.authenticate(request.headers.authorization); }
      catch (error) { limits.request(null, source); throw error; }
      if (!preview) limits.request(identity.userId, source);
      const dispatch = async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const route = `${request.method} ${url.pathname}`;
      if (permissionHub && (pathname.startsWith('/hub') || pathname === '/me/plan')) {
        const result = await hubRoute(permissionHub, request.method, pathname, () => readBody(request));
        return json(result.status, result.body);
      }
      if (route === 'GET /auth/me') return json(200, { user: identity.user });
      if (route === 'POST /auth/logout') { await accounts.logout(identity); return json(200, { loggedOut: true }); }
      if (route === 'GET /workbench') {
        const definition = config.agent?.definition?.agent;
        const visibleKnowledge = knowledge ? await knowledge.list() : [];
        return json(200, { agent: definition ? { id: definition.id, ...(definition.name ? { name: definition.name } : {}), version: definition.version,
          skills: permissionHub ? permissionHub.visible().filter(r => r.type === 'skill') : definition.skills, tools: permissionHub ? { allow: tools.snapshot().tools.map(t => t.name) } : definition.tools, memory: definition.memory,
          outputs: definition.outputs, knowledge: visibleKnowledge.map(kb => ({ kbId: kb.kbId, mode: kb.desiredMode, actions: kb.actions })), workflows: config.agent.workflows.list() } : null,
          queueBackend: messages.backend, capabilities: { workspace: Boolean(files), knowledge: Boolean(knowledge) },
          storage: { business: 'PostgreSQL', wakeup: 'Redis', content: 'workspace + immutable blobs', history: 'Codex native' } });
      }
      if (preview) {
        if (!files) throw previewMissing();
        const { content } = await files.read_preview({ path: claim.path });
        if (previewHash(content) !== claim.sha256) throw new AppError('文件已变化，请刷新预览。', 410);
        response.writeHead(200, previewHeaders(claim.path)); response.end(content); return;
      }
      if (route === 'POST /previews') {
        const body = await readBody(request);
        if (!files || Object.keys(body).join(',') !== 'path') throw previewMissing();
        let output;
        try { output = await files.read_preview({ path: previewPath(body.path) }); } catch { throw previewMissing(); }
        return json(200, createPreview(config.previewSecret, identity.userId, body.path, output.content));
      }
      if (route === 'GET /workspace' && files) return json(200, await files.list_files({ path: url.searchParams.get('path') || '' }));
      if (route === 'GET /workspace/read' && files) return json(200, await files.read_file({ path: url.searchParams.get('path'), max_chars: 262144 }));
      if (route === 'GET /knowledge/pages' && knowledge) return json(200, await knowledge.pages(url.searchParams.get('kbId')));
      if (route === 'POST /knowledge/source' && knowledge) return json(201, await knowledge.importSource(await readBody(request)));

      if (route === 'POST /knowledge' && knowledge) return json(201, await knowledge.create(await readBody(request)));
      if (request.method === 'DELETE' && /^\/knowledge\/[^/]+$/.test(pathname) && knowledge) return json(200, await knowledge.delete(decodeURIComponent(pathname.slice('/knowledge/'.length))));
      if (route === 'GET /knowledge' && knowledge) return json(200, { knowledge: await knowledge.list() });
      if (route === 'GET /knowledge/read' && knowledge) return json(200, await knowledge.read({ kbId: url.searchParams.get('kbId'), slug: url.searchParams.get('slug') }));
      if (route === 'POST /knowledge/search' && knowledge) return json(200, await knowledge.search(await readBody(request)));
      if (route === 'POST /knowledge/index' && knowledge) {
        const body = await readBody(request);
        if (Object.keys(body).join(',') !== 'kbId') throw new AppError('只接受 kbId。');
        return json(202, await knowledge.enqueueIndex(body.kbId));
      }
      if (route === 'GET /knowledge/job' && knowledge) return json(200, await knowledge.job(url.searchParams.get('id')));
      if (route === 'GET /resources/read'  && resources) return json(200, await resources.readById(url.searchParams.get('id')));
      if (route === 'GET /preferences' && data?.repository) return json(200, { preferences: await data.repository.preferences(), injectedIntoContext: false });
      if (route === 'POST /preferences' && data?.repository) {
        const body = await readBody(request);
        await data.repository.setPreference(body.key, body.value); return json(200, { saved: true, injectedIntoContext: false });
      }
      if (route === "GET /models") return json(200, config.launch.router?.catalog() || {
        models: {}, scenes: {}, defaults: { chat: config.launch.model || null }, webSearch: config.launch.webSearch || "disabled"
      });
      if (route === "GET /usage") return json(200, await usage.summary(url.searchParams.get("period") || "today"));
      if (route === "GET /memory") return json(200, await memory.snapshot());
      if (route === "GET /memory/summary") return json(200, await memory.summary());
      if (route === "POST /memory/contribution") {
        const body = await readBody(request);
        if (Object.keys(body).some(key => !["threadId", "enabled"].includes(key))) throw new AppError("记忆参与设置只接受 threadId 和 enabled。");
        return json(200, await memory.contribute(body.threadId, body.enabled));
      }
      if (route === "GET /tools") return json(200, tools.snapshot());
      if (route === "GET /sessions") return json(200, { sessions: await sessions.list(url.searchParams.get("q") || "") });
      if (route === "POST /sessions") {
        const body = await readBody(request);
        if (Object.keys(body).some(key => key !== 'agent')) throw new AppError('只接受 agent。', 400);
        if (permissionHub && body.agent) permissionHub.checkResource('agent', body.agent, 'use');
        return json(201, await sessions.create());
      }
      if (route === "POST /sessions/resume") {
        const body = await readBody(request);
        const session = await sessions.ensure(body.threadId);
        const missing = await data?.jobs?.missing?.(body.threadId) || [];
        return json(200, { ...session, ...(missing.length ? { warnings: missing.map(t => ({ taskId: t.id, message: t.error })) } : {}) });
      }
      if (route === "GET /state") {
        const id = url.searchParams.get("threadId");
        await sessions.ensure(id);
        return json(200, { session: sessions.snapshot(id), queue: await messages.snapshot(id) });
      }
      if (route === "POST /messages") return json(202, await messages.submit(await readBody(request)));
      if (route === "POST /tasks/confirm") return json(200, await messages.confirm(await readBody(request)));
      if (route === "POST /tasks/revise") return json(200, await messages.revise(await readBody(request)));
      if (route === "POST /tasks/cancel") return json(200, await messages.cancel(await readBody(request)));
      if (route === "POST /queue/continue") {
        const body = await readBody(request);
        return json(200, await messages.continue(body.threadId));
      }
      if (route === "GET /events") {
        const release = limits.acquireSse();
        response.once('close', release);
        const id = url.searchParams.get("threadId");
        await sessions.ensure(id);
        if (response.destroyed) return;
        const buffered = [];
        let ready = false;
        let heartbeat;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform",
          connection: "keep-alive", "x-accel-buffering": "no"
        });
        response.flushHeaders();
        response.shardUserId = identity.userId;
        streams.add(response);
        // 带编号的帧会更新客户端的 Last-Event-ID；不带编号的帧不影响断点。
        const write = (event, sequence) => {
          if (response.destroyed) return;
          if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
          response.write(`${sequence != null ? `id: ${hub.eventId(sequence)}\n` : ""}data: ${encode(event)}\n\n`);
        };
        const listener = event => { if (event.ownerId === identity.userId && (!event.threadId || event.threadId === id)) {
          if (ready) write(event, event.sequence);
          else if (buffered.length < 1000) buffered.push(event);
          else response.destroy();
        } };
        hub.on("event", listener);
        response.once('close', () => { clearInterval(heartbeat); hub.off('event', listener); streams.delete(response); });
        // 断线重连且缓冲还覆盖得到：只补发错过的事件；否则从快照开始。
        const missed = hub.since(request.headers["last-event-id"], id, identity.userId);
        if (missed) for (const event of missed) write(event, event.sequence);
        else {
          const queue = await messages.snapshot(id);
          write({ ownerId: identity.userId, type: "snapshot", threadId: id, protocol: 2, data: { session: sessions.snapshot(id), queue } }, hub.sequence);
          // 等待队列快照期间缓冲的会话事件已包含在会话快照里；其余事件照常补发，但不带编号，避免断点倒退。
          for (const event of buffered) if (!SESSION_EVENT_TYPES.has(event.type)) write(event, null);
        }
        ready = true;
        if (!response.destroyed) heartbeat = setInterval(() => { if (!response.destroyed) response.write(": heartbeat\n\n"); }, 15000);
        return;
      }
      throw new AppError("接口不存在。", 404);
      };
      return await runIdentity(identity, () => {
        const operation = () => gate && !pathname.startsWith('/hub') && pathname !== '/me/plan' && !pathname.startsWith('/auth/') ? gate.run(gate.user(), dispatch) : dispatch();
        const resourceOnly = config.sharding && (['/knowledge/search', '/knowledge/read', '/knowledge/pages', '/resources/read'].includes(pathname) ||
          (shardUser() && shardUser() !== identity.userId));
        const dispatchUser = () => {
          if (resourceOnly && gate?.forResource) return gate.forResource(operation);
          if (sessions.rpc?.pool && !pathname.startsWith('/auth/') && !pathname.startsWith('/hub') && pathname !== '/me/plan')
            return sessions.rpc.pool.withOwner(identity.userId, operation);
          return operation();
        };
        const work = () => permissionHub ? permissionHub.withUser(identity.userId, dispatchUser) : dispatchUser();
        return Promise.resolve().then(work).catch(error => {
          if (preview && error.status !== 410) throw previewMissing();
          if (!error.status || error.status >= 500) logFailure(error, { ...config.generation, log }, error, '', 'HTTP');
          throw error;
        });
      });
    } catch (error) {
      if (request.method === 'GET' && request.url.startsWith('/preview/') && ![410, 429, 403].includes(error.status)) error = previewMissing();
      if ((!error.status || error.status >= 500) && !error.databaseDiagnostic) logFailure(error, { ...config.generation, log }, error, '', 'HTTP');
      if (error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
      if (!response.headersSent) json(error.status || 500, { error: { message: error.status === 404 ? "资源不存在。" : error.status ? error.message : "服务暂时不可用。", code: error.code || "SERVER_ERROR" } });
      else response.end();
    }
  };
  const server = createServer((request, response) => {
    const work = () => handle(request, response);
    void work().catch(() => response.destroy());
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server, handle, limits,
    closeUserStreams(userId) { for (const stream of streams) if (stream.shardUserId === userId) stream.end(); },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
      });
      // 监听全部网卡（容器里）时本机地址同样可达；连接信息统一写 127.0.0.1，工作台只认这个。
      return `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.address().port}`;
    },
    async close() {
      for (const stream of streams) stream.end();
      if (!server.listening) return;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}
