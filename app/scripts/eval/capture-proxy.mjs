// 透传代理：放在 Codex 与模型服务之间，原样转发请求与流式响应，只记下请求体，用来分析每次请求里各部分占多少。
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

const hopHeaders = ["host", "connection", "content-length", "transfer-encoding", "keep-alive"];

export async function captureProxy(upstreamBase) {
  const upstream = new URL(upstreamBase), requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      try { requests.push(JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString())); } catch { requests.push(null); }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hopHeaders.includes(name)));
      const reply = await fetch(new URL(request.url, upstream.origin), { method: request.method, headers, body: raw.length ? raw : undefined });
      // fetch 已经解压响应，转发时去掉原来的压缩与长度头。
      response.writeHead(reply.status, Object.fromEntries([...reply.headers].filter(([name]) => ![...hopHeaders, "content-encoding"].includes(name))));
      if (reply.body) Readable.fromWeb(reply.body).pipe(response); else response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(502);
      response.end(`capture proxy: ${error.message}`);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}${upstream.pathname.replace(/\/$/, "")}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

// 一次请求的组成（字符数）：基础指令、工具定义、以及输入里各角色的消息与工具往返。
export function composition(body) {
  const size = value => typeof value === "string" ? value.length : JSON.stringify(value ?? "").length;
  const parts = { instructions: size(body.instructions), tools: size(body.tools) };
  for (const item of body.input || []) {
    const key = item.type === "message" ? `message:${item.role}` : item.type;
    parts[key] = (parts[key] || 0) + size(item.type === "message" ? (item.content || []).map(part => part.text || "").join("") : item);
  }
  return parts;
}
