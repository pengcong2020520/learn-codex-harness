import { pathToFileURL } from "node:url";
import { AgentClient, loadClientConnection } from "./modules/connection/index.mjs";
import { createTerminal } from "./modules/terminal/index.mjs";
import { runChat } from "./modules/chat/index.mjs";

export async function main() {
  // 1. 读取服务连接信息（不是模型配置）。
  const api = new AgentClient(loadClientConnection());
  // 2. 确认自己的 Agent 服务已就绪。
  const health = await api.request("/health");
  console.log(`Agent 服务已连接；模型：${health.model || "服务端默认"}`);
  // 3. 进入终端交互；退出时不关闭服务端。
  await runChat(api, createTerminal());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
