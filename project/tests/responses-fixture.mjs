// 仅测试使用：真实 Codex 连接本机假模型，不携带真实 API Key。
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { cleanup } from "./helpers.mjs";

export function sendResponse(response, item) {
  const id = randomUUID();
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: item.type === "function_call"
    ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
  if (item.type === "function_call") {
    event("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
    event("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    const fields = { item_id: item.id, output_index: 0, content_index: 0 };
    event("response.content_part.added", { ...fields, part: { type: "output_text", text: "", annotations: [] } });
    event("response.output_text.delta", { ...fields, delta: item.content[0].text });
    event("response.output_text.done", { ...fields, text: item.content[0].text });
    event("response.content_part.done", { ...fields, part: item.content[0] });
  }
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { id, object: "response", status: "completed", output: [item],
    usage: { input_tokens: 1000, output_tokens: 300, total_tokens: 1300 } } });
  response.end();
}

export const answer = text => ({ type: "message", id: randomUUID(), role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
export const toolSpecs = body => (body.tools || []).flatMap(tool => tool.type === "namespace"
  ? tool.tools.map(item => ({ ...item, namespace: tool.name })) : [tool]);
export const toolCall = (spec, args) => ({ type: "function_call", id: randomUUID(), call_id: randomUUID(),
  name: spec.name, ...(spec.namespace ? { namespace: spec.namespace } : {}), arguments: JSON.stringify(args), status: "completed" });

export async function responsesFixture(root, respond) {
  const requests = [], errors = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
      requests.push(body);
      sendResponse(response, await respond(body));
    } catch (error) { errors.push(error); response.writeHead(500); response.end("local fixture failed"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup(root, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, errors, url: `http://127.0.0.1:${server.address().port}/v1` };
}
