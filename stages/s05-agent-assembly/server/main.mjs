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
import { AgentDefinition } from "./modules/agents/index.mjs";
import { verifySkills } from "./modules/codex/skills.mjs";

// 主流程只组装模块：配置 → 独占锁 → 任务记录 → Agent 定义 → Codex → Skill 核验 → 会话与事件 → 任务调度 → 运行目录维护 → HTTP → 就绪。
export async function startAgentServer({ config = loadServerConfig(), cli, log = console.log } = {}) {
  const lifecycle = createLifecycle();
  const redact = createLogRedactor(config.launch.env.CODEX_API_KEY);
  const safeLog = value => log(redact(value));
  try {
    // 1. 确保同一个项目只有一个服务在运行。
    lifecycle.defer(acquireServerLock(config.root));
    const data = openData(config);

    // 2. 读取并校验 Agent 定义：角色、Skill、执行策略和工作区都来自这一份 JSON；无效就拒绝启动。
    const agent = new AgentDefinition(config.root, config.agentFile);
    const runtime = await prepareRun(config.launch, config.root, { workspaceDir: agent.workspacePath, instructions: agent.instructions });
    lifecycle.defer(() => finishRun(runtime.runDir));
    agent.configure(config, runtime);
    prepareCodexConfig(config);
    const rpc = new CodexConnection({ launch: config.launch, runtime, redact, cli, log: safeLog });
    lifecycle.defer(() => rpc.close());
    await rpc.open();
    rpc.on("fatal", error => { safeLog(`Codex 连接失败：${error.message}`); void rpc.close(); });

    // 3. 只启用定义里声明的 Skill，再生成本次的 Agent 版本（描述符）；之后每一轮发出前都重新核对 Skill。
    const skills = await verifySkills(rpc, agent, runtime.workspaceDir);
    agent.activate(skills);
    for (const warning of agent.warnings) safeLog(warning);

    // 4. 会话与事件：Codex 通知整理成快照，经事件中心推给订阅的客户端。
    const hub = new EventHub();
    const sessions = new SessionService({ rpc, config, runtime, hub, redact,
      beforeTurn: async () => {
        const current = await verifySkills(rpc, agent, runtime.workspaceDir);
        if (JSON.stringify(current) !== JSON.stringify(agent.availableSkills)) throw new Error("Skill 有效集合已变化，请受控重启后新建会话。");
      } });
    lifecycle.defer(() => sessions.close());

    // 5. 任务调度：输入先写进任务记录，再按会话逐条发出；关闭时把未确认的执行标记出来。
    const messages = new MessageService({ rpc, sessions, hub, config, store: data.jobs });
    // 正常关闭不是故障：停止派发，把执行中的标成待核对，Codex 连接随后关闭。
    lifecycle.defer(() => messages.close());
    await messages.open();

    // 6. 服务常驻后，每次启动都会留下一个运行目录；定期清理旧的。
    const maintenance = new RunMaintenance({ root: config.root, runtime, sessions, log: safeLog });
    lifecycle.defer(() => maintenance.close());
    await maintenance.start();
    safeLog("缓存维护已启用：启动时及每小时检查；保留最近 5 次运行和 7 天内记录，不清理使用中的目录。");

    // 7. 启动客户端入口，只监听本机；连接令牌与模型 API Key 完全分开。
    const token = randomBytes(32).toString("hex");
    const http = createHttpService({ config, token, sessions, messages, hub, redact });
    lifecycle.defer(() => http.close());
    // 关闭时先告诉已连接的客户端（在断开事件流之前），客户端据此提示"服务端关闭"，而不是"服务异常"。
    lifecycle.defer(() => hub.publish("shutdown", { message: "服务端正在关闭；排队中的消息会保留，重启后可继续。" }));
    const url = await http.listen();
    publishConnection(config.root, { url, token, pid: process.pid }, lifecycle);

    // 8. 就绪；客户端退出不触发这里的服务关闭。
    safeLog(`Agent 服务已就绪：${url}\nAgent：${agent.definition.agent.id}（版本 ${agent.descriptor.hash.slice(0, 12)}；Skill：${agent.availableSkills.map(skill => skill.name).join("、") || "无"}）\n模型：${config.launch.model || "Codex 默认"}\n工作区：${runtime.workspaceDir}\n协议日志：${runtime.runDir}/protocol.jsonl\n任务记录：.data/messages.json\n另开终端运行 npm run chat；此终端 Ctrl+C 停止服务。`);
    return { config, agent, runtime, rpc, sessions, messages, hub, data, maintenance, url, token, close: () => lifecycle.close() };
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
