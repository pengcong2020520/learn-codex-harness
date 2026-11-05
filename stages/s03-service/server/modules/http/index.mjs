import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "../../../shared/errors.mjs";

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

// HTTP 是客户端的入口；业务逻辑全部交给 sessions 模块。
export function createHttpService({ config, token, sessions, rpc, redact }) {
  const server = createServer(async (request, response) => {
    const json = (status, data) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(redact(data));
    };
    try {
      // 首版仅支持本机 CLI，拒绝网页跨源调用，不对公网暴露执行能力。
      if (request.headers.origin) throw new AppError("当前接口仅供本机 CLI 使用。", 403);
      if (!authenticated(request, token)) throw new AppError("Agent 服务认证失败，请重新连接。", 401);
      const url = new URL(request.url, "http://127.0.0.1");
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /health") return json(rpc.failure ? 503 : 200, { status: rpc.failure ? "degraded" : "ready", model: config.launch.model,
        ...(rpc.failure ? { error: { message: "Codex 连接已失效，请重启服务并核对会话状态。" } } : {}) });
      if (route === "GET /sessions") return json(200, { sessions: await sessions.list(url.searchParams.get("q") || "") });
      if (route === "POST /sessions") { await readBody(request); return json(201, await sessions.create()); }
      if (route === "POST /sessions/resume") {
        const body = await readBody(request);
        return json(200, await sessions.ensure(body.threadId));
      }
      if (route === "GET /state") {
        const id = url.searchParams.get("threadId");
        await sessions.ensure(id);
        return json(200, { session: sessions.snapshot(id) });
      }
      // 提交后立即返回 202：这一轮在服务端执行，客户端用 GET /state 查看进度。
      if (route === "POST /turns") {
        const body = await readBody(request);
        return json(202, await sessions.startTurn(body.threadId, body.text));
      }
      throw new AppError("接口不存在。", 404);
    } catch (error) {
      if (!response.headersSent) json(error.status || 500, { error: { message: error.message, code: error.code || "SERVER_ERROR" } });
      else response.end();
    }
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
      if (!server.listening) return;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}
