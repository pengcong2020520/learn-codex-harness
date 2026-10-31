import { readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../../../shared/paths.mjs";

// 客户端只读取 Agent 服务连接信息；不读取 .env，不加载 Codex，不接触模型密钥。
export function loadClientConnection(environment = process.env, root = PROJECT_ROOT) {
  if (environment.AGENT_SERVER_URL) {
    const url = new URL(environment.AGENT_SERVER_URL);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("AGENT_SERVER_URL 格式不正确。");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("非本机服务必须使用 HTTPS。");
    if (!environment.AGENT_SERVER_TOKEN) throw new Error("指定服务地址时，还需要 AGENT_SERVER_TOKEN（不是模型 API Key）。");
    return { url: url.origin, token: environment.AGENT_SERVER_TOKEN };
  }
  try {
    const value = JSON.parse(readFileSync(path.join(root, ".data", "connection.json"), "utf8"));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url) || typeof value.token !== "string") throw new Error();
    return value;
  } catch { throw new Error("未找到本项目的服务连接信息。请先在另一个终端运行 npm run server。"); }
}

export class AgentClient {
  constructor(connection) { this.connection = connection; }
  async request(route, body, signal) {
    let response;
    try {
      response = await fetch(this.connection.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.connection.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal || AbortSignal.timeout(15000)
      });
    } catch (error) {
      throw new Error(`无法连接 Agent 服务或请求未确认；请检查服务端终端。${body === undefined ? "" : " 不要盲目重复发送同一条消息。"}`, { cause: error });
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
    return result;
  }

  subscribe(threadId, onEvent, onStatus = () => {}) {
    const controller = new AbortController();
    const { signal } = controller;
    const done = (async () => {
      while (!signal.aborted) {
        try {
          const response = await fetch(`${this.connection.url}/events?threadId=${encodeURIComponent(threadId)}`, {
            headers: { authorization: `Bearer ${this.connection.token}` }, signal
          });
          if (!response.ok) throw new Error(`事件连接失败：HTTP ${response.status}`);
          onStatus("connected");
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
              if (data) onEvent(JSON.parse(data));
            }
            if (buffer.length > 4 * 1024 * 1024) throw new Error("事件帧过大。");
          }
          if (!signal.aborted) throw new Error("事件连接中断。");
        } catch (error) {
          if (signal.aborted) break;
          onStatus("reconnecting", error.message);
          await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
            const timer = setTimeout(finish, 1000);
            signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
    })();
    return { close: () => controller.abort(), done };
  }
}
