import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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

function authenticated(request, token) {
  const provided = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// HTTP 是客户端的入口；业务逻辑全部交给 sessions / messages 模块。
export function createHttpService({ config, token, sessions, messages, hub, redact, tools, memory, data, resources, gate, knowledge, files }) {
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
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(redact(data));
    };
    try {
      // 首版仅支持本机 CLI，拒绝网页跨源调用，不对公网暴露执行能力。
      if (request.headers.origin) throw new AppError("当前接口仅供本机 CLI 使用。", 403);
      if (!authenticated(request, token)) throw new AppError("Agent 服务认证失败，请重新连接。", 401);
      const dispatch = async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const route = `${request.method} ${url.pathname}`;
      if (route === 'GET /workbench') {
        const definition = config.agent?.definition?.agent;
        return json(200, { agent: definition ? { id: definition.id, version: definition.version,
          skills: definition.skills, tools: definition.tools, memory: definition.memory,
          outputs: definition.outputs, knowledge: definition.knowledge || [], workflows: config.agent.workflows.list() } : null,
          queueBackend: messages.backend, capabilities: { workspace: Boolean(files), knowledge: Boolean(knowledge) },
          storage: { business: 'PostgreSQL', wakeup: 'Redis', content: 'workspace + immutable blobs', history: 'Codex native' } });
      }
      if (route === 'GET /workspace' && files) return json(200, await files.list_files({ path: url.searchParams.get('path') || '' }));
      if (route === 'GET /workspace/read' && files) return json(200, await files.read_file({ path: url.searchParams.get('path'), max_chars: 262144 }));
      if (route === 'GET /knowledge/pages' && knowledge) return json(200, await knowledge.pages(url.searchParams.get('kbId')));
      if (route === 'POST /knowledge/source' && knowledge) return json(201, await knowledge.importSource(await readBody(request)));

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
      if (route === "GET /memory") return json(200, memory.snapshot());
      if (route === "GET /memory/summary") return json(200, memory.summary());
      if (route === "POST /memory/contribution") {
        const body = await readBody(request);
        if (Object.keys(body).some(key => !["threadId", "enabled"].includes(key))) throw new AppError("记忆参与设置只接受 threadId 和 enabled。");
        return json(200, await memory.contribute(body.threadId, body.enabled));
      }
      if (route === "GET /tools") return json(200, tools.snapshot());
      if (route === "GET /health") return json(messages.failure || tools?.broken || data?.queue?.healthy === false ? 503 : 200, { status: messages.failure || tools?.broken || data?.queue?.healthy === false ? "degraded" : "ready", model: config.launch.model, queueBackend: messages.backend,
        tools: tools?.snapshot(),
        ...(messages.failure ? { error: { message: "Codex 连接已失效，请重启服务并核对任务状态。" } } : {}) });
      if (route === "GET /sessions") return json(200, { sessions: await sessions.list(url.searchParams.get("q") || "") });
      if (route === "POST /sessions") { await readBody(request); return json(201, await sessions.create()); }
      if (route === "POST /sessions/resume") {
        const body = await readBody(request);
        return json(200, await sessions.ensure(body.threadId));
      }
      if (route === "GET /state") {
        const id = url.searchParams.get("threadId");
        await sessions.ensure(id);
        return json(200, { session: sessions.snapshot(id), queue: await messages.snapshot(id) });
      }
      if (route === "POST /messages") return json(202, await messages.submit(await readBody(request)));
      if (route === "POST /queue/continue") {
        const body = await readBody(request);
        return json(200, await messages.continue(body.threadId));
      }
      if (route === "GET /events") {
        const id = url.searchParams.get("threadId");
        await sessions.ensure(id);
        const buffered = [];
        let ready = false;
        let heartbeat;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
          connection: "keep-alive", "x-accel-buffering": "no"
        });
        response.flushHeaders();
        streams.add(response);
        // 带编号的帧会更新客户端的 Last-Event-ID；不带编号的帧不影响断点。
        const write = (event, sequence) => {
          if (response.destroyed) return;
          if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
          response.write(`${sequence != null ? `id: ${hub.eventId(sequence)}\n` : ""}data: ${encode(event)}\n\n`);
        };
        const listener = event => { if (!event.threadId || event.threadId === id) {
          if (ready) write(event, event.sequence);
          else if (buffered.length < 1000) buffered.push(event);
          else response.destroy();
        } };
        hub.on("event", listener);
        response.once('close', () => { clearInterval(heartbeat); hub.off('event', listener); streams.delete(response); });
        // 断线重连且缓冲还覆盖得到：只补发错过的事件；否则从快照开始。
        const missed = hub.since(request.headers["last-event-id"], id);
        if (missed) for (const event of missed) write(event, event.sequence);
        else {
          const queue = await messages.snapshot(id);
          write({ type: "snapshot", threadId: id, protocol: 2, data: { session: sessions.snapshot(id), queue } }, hub.sequence);
          // 等待队列快照期间缓冲的会话事件已包含在会话快照里；其余事件照常补发，但不带编号，避免断点倒退。
          for (const event of buffered) if (!SESSION_EVENT_TYPES.has(event.type)) write(event, null);
        }
        ready = true;
        if (!response.destroyed) heartbeat = setInterval(() => { if (!response.destroyed) response.write(": heartbeat\n\n"); }, 15000);
        return;
      }
      throw new AppError("接口不存在。", 404);
      };
      return await (gate ? gate.run(gate.user(), dispatch) : dispatch());
    } catch (error) {
      if (!response.headersSent) json(error.status || 500, { error: { message: error.message, code: error.code || "SERVER_ERROR" } });
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
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
      });
      return `http://${config.host}:${server.address().port}`;
    },
    async close() {
      for (const stream of streams) stream.end();
      if (!server.listening) return;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}
