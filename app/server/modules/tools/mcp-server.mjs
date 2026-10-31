import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// MCP 协议由官方 SDK 处理；每版目录有独立 URL，旧调用不会切换到新实现。
export async function createMcpToolServer({ token, redact }) {
  const registries = new Map(), connections = new Set();
  const state = { registries, activeCalls: 0 };
  const expected = Buffer.from(`Bearer ${token}`);
  const http = createServer(async (request, response) => {
    const auth = Buffer.from(request.headers.authorization || "");
    if (request.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) { response.writeHead(403); response.end(); return; }
    const registry = registries.get(request.url?.slice(1));
    if (!registry) { response.writeHead(404); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const controller = new AbortController();
    const server = new Server({ name: "project-tools", version: registry.version.slice(0, 16) }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    connections.add(server);
    response.once("close", () => { controller.abort(); connections.delete(server); void server.close().catch(() => {}); });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: registry.specs }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      state.activeCalls++;
      try {
        const result = await registry.call({ tool: params.name, arguments: params.arguments || {} },
          { signal: AbortSignal.any([extra.signal, controller.signal, AbortSignal.timeout(30000)]) });
        return { isError: !result.success, content: result.contentItems.map(item => ({ type: "text", text: redact(item.text) })) };
      } finally { state.activeCalls--; }
    });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 1024 * 1024) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  http.requestTimeout = 35000; http.headersTimeout = 10000;
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  return Object.assign(state, {
    url: `http://127.0.0.1:${http.address().port}`,
    async close() {
      await Promise.all([...connections].map(server => server.close().catch(() => {})));
      await new Promise(resolve => { http.close(resolve); http.closeAllConnections(); });
    }
  });
}
