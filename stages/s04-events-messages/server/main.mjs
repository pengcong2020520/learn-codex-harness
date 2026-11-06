import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadServerConfig, createLogRedactor } from "./modules/config/index.mjs";
import { acquireServerLock } from "./modules/storage/index.mjs";
import { createLifecycle, publishConnection } from "./modules/lifecycle/index.mjs";
import { prepareRun, finishRun } from "./modules/codex/runtime.mjs";
import { CodexConnection } from "./modules/codex/connection.mjs";
import { prepareCodexConfig } from "./modules/codex/config.mjs";
import { EventHub } from "./modules/events/index.mjs";
import { SessionService } from "./modules/sessions/index.mjs";
import { MessageService } from "./modules/messages/index.mjs";
import { openData } from "./modules/data/index.mjs";
import { createHttpService } from "./modules/http/index.mjs";
import { RunMaintenance } from "./modules/maintenance/index.mjs";
import { AGENT_INSTRUCTIONS } from "./modules/role/index.mjs";

// 主流程只组装模块：配置 → 独占锁 → 任务记录 → Codex → 会话与事件 → 任务调度 → 运行目录维护 → HTTP → 就绪。
export async function startAgentServer({ config = loadServerConfig(), cli, log = console.log, dataFactory = openData } = {}) {
  const lifecycle = createLifecycle();
  const redact = createLogRedactor(config.launch.env.CODEX_API_KEY);
  const safeLog = value => log(redact(value));
  try {
    // 1. 确保同一个项目只有一个服务在运行。
    lifecycle.defer(acquireServerLock(config.root));
    const data = await dataFactory(config);
    lifecycle.defer(() => data.close());

    // 2. 准备运行目录，由自己的服务自动启动本机 Codex。
    const runtime = await prepareRun(config.launch, config.root, { instructions: AGENT_INSTRUCTIONS });
    lifecycle.defer(() => finishRun(runtime.runDir));
    prepareCodexConfig(config);
    const rpc = new CodexConnection({ launch: config.launch, runtime, redact, cli, log: safeLog });
    lifecycle.defer(() => rpc.close());
    await rpc.open();
    rpc.on("fatal", error => { safeLog(`Codex 连接失败：${error.message}`); void rpc.close(); });

    // 3. 会话与事件：Codex 通知整理成快照，经事件中心推给订阅的客户端。
    const hub = new EventHub();
    const sessions = new SessionService({ rpc, config, runtime, hub, redact });
    lifecycle.defer(() => sessions.close());

    // 4. 任务调度：输入先写进任务记录，再按会话逐条发出；关闭时把未确认的执行标记出来。
    const messages = new MessageService({ rpc, sessions, hub, config, store: data.jobs });
    lifecycle.defer(async () => {
      await messages.fail(new Error("服务正在关闭，执行结果待核对。"));
      await rpc.close();
      await messages.close();
    });
    await messages.open();

    // 5. 服务常驻后，每次启动都会留下一个运行目录；定期清理旧的。
    const maintenance = new RunMaintenance({ root: config.root, runtime, sessions, log: safeLog });
    lifecycle.defer(() => maintenance.close());
    await maintenance.start();
    safeLog("缓存维护已启用：启动时及每小时检查；保留最近 5 次运行和 7 天内记录，不清理使用中的目录。");

    // 6. 启动客户端入口，只监听本机；连接令牌与模型 API Key 完全分开。
    const token = randomBytes(32).toString("hex");
    const http = createHttpService({ config, token, sessions, messages, hub, redact });
    lifecycle.defer(() => http.close());
    const url = await http.listen();
    publishConnection(config.root, { url, token, pid: process.pid }, lifecycle);

    // 7. 就绪；客户端退出不触发这里的服务关闭。
    safeLog(`Agent 服务已就绪：${url}\n模型：${config.launch.model || "Codex 默认"}\n工作目录：${runtime.workspaceDir}\n协议日志：${runtime.runDir}/protocol.jsonl\n任务记录：.data/messages.json\n另开终端运行 npm run chat；此终端 Ctrl+C 停止服务。`);
    return { config, runtime, rpc, sessions, messages, hub, data, maintenance, url, token, close: () => lifecycle.close() };
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
    console.log("正在关闭服务；待执行消息会保留，未确认的执行不会自动重发。");
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
