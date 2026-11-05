import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadServerConfig, createLogRedactor } from "./modules/config/index.mjs";
import { acquireServerLock } from "./modules/storage/index.mjs";
import { createLifecycle, publishConnection } from "./modules/lifecycle/index.mjs";
import { prepareRun, finishRun } from "./modules/codex/runtime.mjs";
import { CodexConnection } from "./modules/codex/connection.mjs";
import { prepareCodexConfig } from "./modules/codex/config.mjs";
import { SessionService } from "./modules/sessions/index.mjs";
import { createHttpService } from "./modules/http/index.mjs";
import { RunMaintenance } from "./modules/maintenance/index.mjs";
import { AGENT_INSTRUCTIONS } from "./modules/role/index.mjs";

// 主流程只组装模块：配置 → 独占锁 → Codex → 会话 → 运行目录维护 → HTTP → 就绪。
export async function startAgentServer({ config = loadServerConfig(), cli, log = console.log } = {}) {
  const lifecycle = createLifecycle();
  const redact = createLogRedactor(config.launch.env.CODEX_API_KEY, [config.data?.databaseUrl, config.data?.redisUrl]);
  const safeLog = value => log(redact(value));
  try {
    // 1. 确保同一个项目只有一个服务在运行。
    lifecycle.defer(acquireServerLock(config.root));

    // 2. 准备运行目录，由自己的服务自动启动本机 Codex。
    const runtime = await prepareRun(config.launch, config.root, { instructions: AGENT_INSTRUCTIONS });
    lifecycle.defer(() => finishRun(runtime.runDir));
    prepareCodexConfig(config);
    const rpc = new CodexConnection({ launch: config.launch, runtime, redact, cli, log: safeLog });
    lifecycle.defer(() => rpc.close());
    await rpc.open();
    rpc.on("fatal", error => { safeLog(`Codex 连接失败：${error.message}`); void rpc.close(); });

    // 3. 会话模块：新建、恢复会话，替客户端发起一轮。
    const sessions = new SessionService({ rpc, config, runtime, redact });
    lifecycle.defer(() => sessions.close());

    // 4. 服务常驻后，每次启动都会留下一个运行目录；定期清理旧的。
    const maintenance = new RunMaintenance({ root: config.root, runtime, sessions, log: safeLog });
    lifecycle.defer(() => maintenance.close());
    await maintenance.start();
    safeLog("缓存维护已启用：启动时及每小时检查；保留最近 5 次运行和 7 天内记录，不清理使用中的目录。");

    // 5. 启动客户端入口，只监听本机；连接令牌与模型 API Key 完全分开。
    const token = randomBytes(32).toString("hex");
    const http = createHttpService({ config, token, sessions, rpc, redact });
    lifecycle.defer(() => http.close());
    const url = await http.listen();
    publishConnection(config.root, { url, token, pid: process.pid }, lifecycle);

    // 6. 就绪；客户端退出不触发这里的服务关闭。
    safeLog(`Agent 服务已就绪：${url}\n模型：${config.launch.model || "Codex 默认"}\n工作目录：${runtime.workspaceDir}\n协议日志：${runtime.runDir}/protocol.jsonl\n另开终端运行 npm run chat；此终端 Ctrl+C 停止服务。`);
    return { config, runtime, rpc, sessions, maintenance, url, token, close: () => lifecycle.close() };
  } catch (error) {
    await lifecycle.close().catch(() => {});
    throw new Error(redact(error.message));
  }
}

export async function main() {
  const app = await startAgentServer();
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log("正在关闭服务；执行中的一轮会被中止，原生历史保留在 .data/codex。");
    try { await app.close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
