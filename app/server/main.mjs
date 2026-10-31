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
import { createHttpService } from "./modules/http/index.mjs";
import { ToolManager } from "./modules/tools/index.mjs";
import { RunMaintenance } from "./modules/maintenance/index.mjs";
import { MemoryService } from "./modules/memory/index.mjs";
import { AgentDefinition } from "./modules/agents/index.mjs";
import { ExecutionBoundary } from "./modules/agents/boundary.mjs";
import { createFileTools } from "./modules/data/files.mjs";
import { installSkills, verifySkills } from "./modules/codex/skills.mjs";
import path from 'node:path';
import { PermissionGate } from './modules/permissions/index.mjs';
import { KnowledgeService } from './modules/knowledge/index.mjs';
import { createRag } from './modules/knowledge/rag.mjs';
import { KnowledgeWorker } from './modules/knowledge/worker.mjs';
import { openData } from "./modules/data/index.mjs";

// 主流程只组装模块：配置 → 独占锁 → 数据服务 → Codex → 业务模块 → HTTP → 就绪。
export async function startAgentServer({ config = loadServerConfig(), cli, log = console.log, dataFactory = openData, validationOnly = false } = {}) {
  const lifecycle = createLifecycle();
  const redact = createLogRedactor(config.launch.env.CODEX_API_KEY, [config.data?.databaseUrl, config.data?.redisUrl, config.rag?.apiKey]);
  const safeLog = value => log(redact(value));
  try {
    // 1. 确保同一个项目只有一个服务调度队列。
    lifecycle.defer(acquireServerLock(config.root));
    let databaseFailure;
    let messages;
    let engine;
    const data = await dataFactory(config, { onLost: error => { databaseFailure = error; void messages?.fail(error); void engine?.close(); } });
    lifecycle.defer(() => data.close());

    // 2. 准备运行目录，由自己的服务自动启动本机 Codex。
    const agent = new AgentDefinition(config.root, config.agentFile);
    agent.repository = data.repository;
    const runtime = await prepareRun(config.launch, config.root, { workspaceDir: agent.workspacePath, instructions: agent.instructions });
    lifecycle.defer(() => finishRun(runtime.runDir));
    agent.configure(config, runtime);
    const localFiles = createFileTools(config.root, { workspaceDir: runtime.workspaceDir, sources: agent.sources,
      outputs: agent.outputs, assertCurrent: () => agent.assertCurrent() });
    const gate = data.scope ? new PermissionGate({ scope: data.scope, agent }) : null;
    lifecycle.defer(() => gate?.close());
    const resources = data.resources?.({ files: localFiles, sources: agent.sources, outputs: agent.outputs, gate });
    const rag = gate ? await createRag(config.rag, path.join(config.root, '.data/knowledge/bm25')) : null;
    const knowledge = gate ? await new KnowledgeService(data.pool, data.scope, { agent, gate, resources, rag, redact }).open() : null;
    if (knowledge) agent.knowledgeModes = knowledge.modes;
    if (knowledge && rag && !validationOnly) {
      knowledge.worker = await new KnowledgeWorker(knowledge, data.queue.commands).open();
      lifecycle.defer(() => knowledge.worker.close());
    }
    const files = resources ? { workspace: localFiles.workspace,
      ...Object.fromEntries(['list_files','read_file','write_file'].map(name => [name, async args => {
        const action = name === 'list_files' ? 'list' : name === 'read_file' ? 'read' : 'create';
        gate?.check(action, { path: args.path || '' });
        if (knowledge?.wikiPath(args.path || '')) throw new Error('Wiki 生效内容请使用 kb_read / kb_submit_revision；普通文件写入不产生生效知识。');
        const result = await resources[name](args);
        if (name === 'list_files' && gate) result.entries = result.entries.filter(entry => {
          try { gate.check('list', { path: [args.path, entry.name].filter(Boolean).join('/') }); return true; } catch { return false; }
        });
        return result;
      }])) } : localFiles;
    const boundary = new ExecutionBoundary();
    const tools = new ToolManager({ config, runtime, files, agent, gate, knowledge, boundary, log: safeLog, redact });
    lifecycle.defer(() => tools.close());
    await tools.open();
    installSkills(agent, prepareCodexConfig(config, tools.configuration()).home);
    const rpc = new CodexConnection({ launch: config.launch, runtime, redact, cli, log: safeLog });
    engine = rpc;
    lifecycle.defer(() => rpc.close());
    await rpc.open();

    // 3. 组装业务模块。模块之间通过明确接口和事件协作。
    const hub = new EventHub();
    const skills = await verifySkills(rpc, agent, runtime.workspaceDir);
    const sessions = new SessionService({ rpc, config, runtime, hub, redact, tools, boundary, repository: data.repository,
      beforeTurn: async () => {
        const current = await verifySkills(rpc, agent, runtime.workspaceDir);
        if (JSON.stringify(current) !== JSON.stringify(agent.availableSkills)) throw new Error("Skill 有效集合已变化，请受控重启后新建会话。");
      } });
    lifecycle.defer(() => sessions.close());
    tools.attach({ rpc, isBusy: () => [...sessions.sessions.values()].some(session => session.activeTurnId), hub });
    await tools.verify();
    const memory = new MemoryService({ rpc, config, sessions, redact });
    await memory.verify();
    await agent.activate(tools.registry.compatibilityVersion, skills);
    // Prepare the verified descriptor without consuming queues or publishing an HTTP endpoint.
    // Upgrade preflight must not fail queued legacy jobs before a compatibility mapping exists.
    if (validationOnly) return { config, agent, runtime, rpc, sessions, tools, memory, data, resources, gate, knowledge, close: () => lifecycle.close() };
    for (const warning of agent.warnings) safeLog(warning);
    safeLog(`记忆配置：${config.memory.enabled ? "已开启" : "关闭"}（不代表已生成）；状态目录：.data/codex/memories`);
    if (config.memory.enabled && memory.generationBlocked) safeLog(memory.snapshot().generationWarning);
    // 启用门禁时使用 dynamicTools；按正在执行的 Thread / Turn 绑定可信权限上下文。
    if (gate) rpc.on('notification', message => {
      const p = message.params;
      if (message.method === 'turn/started') gate.started(p.threadId, p.turn.id);
      if (message.method === 'turn/completed') gate.end(p.threadId, p.turn.id);
    });
    rpc.toolHandler = (params, context) => {
      if (sessions.getTurn(params.threadId, params.turnId)?.status !== "inProgress") throw new Error("工具请求不属于本服务正在执行的轮次。");
      return tools.registry.call(params, { ...context, ...(gate ? { permissionContext: gate.forTurn(params.threadId, params.turnId) } : {}) });
    };
    messages = new MessageService({ rpc, sessions, hub, config, store: data.jobs, queue: data.queue, gate });
    lifecycle.defer(async () => {
      await messages.fail(new Error('服务正在关闭，执行结果待核对。'));
      await rpc.close();
      await messages.close();
    });
    await messages.open();
    if (databaseFailure) throw databaseFailure;
    rpc.on("fatal", error => { safeLog(`Codex 连接失败：${error.message}`); void rpc.close(); });

    const maintenance = new RunMaintenance({ root: config.root, runtime, sessions, log: safeLog });
    lifecycle.defer(() => maintenance.close());
    await maintenance.start();
    safeLog("缓存维护已启用：启动时及每小时检查；保留最近 5 次运行和 7 天内记录，不清理使用中的目录。");

    // 4. 启动客户端入口，只监听本机；连接令牌与模型 API Key 完全分开。
    const token = randomBytes(32).toString("hex");
    const http = createHttpService({ config, token, sessions, messages, hub, redact, tools, memory, data, resources, gate, knowledge, files });
    lifecycle.defer(() => http.close());
    const url = await http.listen();
    publishConnection(config.root, { url, token, pid: process.pid }, lifecycle);
    safeLog('业务状态：PostgreSQL；调度：Redis；正文：workspace 与 .data/files；原生历史：.data/codex。');

    // 5. 就绪；客户端退出不触发这里的服务关闭。
    safeLog(`网络模式：${tools.registry.networkMode === "proxy-debug" ? "本地调试，信任 HTTPS 域名的代理 Fake-IP 映射；生产部署请设置 NODE_ENV=production" : "严格公网地址检查"}`);
    safeLog(`Agent 服务已就绪：${url}\nAgent：${agent.definition.agent.id}\n模型：${config.launch.model || "Codex 默认"}\n资料目录：${runtime.workspaceDir}\n工具：允许范围已核验；数据层运行使用原生动态工具 + 任务门禁\n工具目录：config/tools/（空闲边界更新；权限契约变化后需新建会话）\n协议日志：${runtime.runDir}/protocol.jsonl\n另开终端运行 npm run chat；此终端 Ctrl+C 停止服务。`);
    return { config, agent, runtime, rpc, sessions, messages, hub, tools, memory, maintenance, data, resources, gate, knowledge, url, token, close: () => lifecycle.close() };
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
