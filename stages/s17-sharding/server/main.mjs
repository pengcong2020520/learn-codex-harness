import { logFailure } from './modules/data/diagnostics.mjs';
import { attachKnowledge } from './modules/sharding/knowledge.mjs';
import { trackDispatch } from './modules/coordination/fence.mjs';
import { Hub } from './modules/hub/index.mjs';
import fs from 'node:fs';
import { isolationMode, prepareServiceDirectories } from './modules/runtimes/directories.mjs';
import { createRuntimes } from './modules/runtimes/index.mjs';
import { gracefulShutdown } from "./modules/deployment/index.mjs";
import { Accounts } from "./modules/accounts/index.mjs";
import { AccountStore } from "./modules/accounts/store.mjs";
import { guardStartup } from "./modules/accounts/admin.mjs";
import { runOwner } from "./modules/accounts/context.mjs";
import { identity } from "./modules/data/database.mjs";
import { pathToFileURL } from "node:url";
import { loadServerConfig, createLogRedactor } from "./modules/config/index.mjs";
import { acquireServerLock } from "./modules/storage/index.mjs";
import { createLifecycle, publishConnection } from "./modules/lifecycle/index.mjs";
import { prepareRun, finishRun } from "./modules/codex/runtime.mjs";
import { EventHub } from "./modules/events/index.mjs";
import { SessionService } from "./modules/sessions/index.mjs";
import { MessageService } from "./modules/messages/index.mjs";
import { createHttpService } from "./modules/http/index.mjs";
import { ToolManager } from "./modules/tools/index.mjs";
import { RunMaintenance } from "./modules/maintenance/index.mjs";
import { AgentDefinition } from "./modules/agents/index.mjs";
import { ExecutionBoundary } from "./modules/agents/boundary.mjs";
import { createFileTools } from "./modules/data/files.mjs";
import { createUserFileTools } from "./modules/accounts/workspace.mjs";
import path from 'node:path';
import { PermissionGate } from './modules/permissions/index.mjs';
import { KnowledgeService } from './modules/knowledge/index.mjs';
import { createRag } from './modules/knowledge/rag.mjs';
import { KnowledgeWorker } from './modules/knowledge/worker.mjs';
import { UsageService } from "./modules/usage/index.mjs";
import { pricingWarning } from "./modules/usage/config.mjs";
import { MediaService } from "./modules/media/index.mjs";
import { MediaJobs } from "./modules/media/store.mjs";
import { openData } from "./modules/data/index.mjs";

// 主流程只组装模块：配置 → 独占锁 → 数据服务 → Codex → 业务模块 → HTTP → 就绪。
export async function startAgentServer({ config = loadServerConfig(), cli, log = console.log, dataFactory = openData, validationOnly = false, generation, externalHttp = false } = {}) {
  if (generation) config = { ...config, generation };
  const lifecycle = createLifecycle();
  const redact = createLogRedactor(config.launch.env.CODEX_API_KEY, [config.data?.databaseUrl, config.data?.redisUrl, config.rag?.apiKey]);
  const safeLog = value => log(redact(value));
  try {
    const isolated = isolationMode({ log: safeLog });
    prepareServiceDirectories(config.root, isolated);
    // 1. 确保同一个项目只有一个服务调度队列。
    if (!generation) lifecycle.defer(acquireServerLock(config.root));
    let databaseFailure;
    let messages;
    let engine;
    let media;
    const data = await dataFactory(config, { onLost: error => { databaseFailure = error; void messages?.fail(error); void engine?.close(); void media?.close(); } });
    lifecycle.defer(() => data.close());
    const markUnconfirmed = config.sharding ? () => data.jobs.recover("节点已隔离，执行结果待核对。") : generation ? trackDispatch(data.jobs, data.pool, data.scope.instanceId) : null;
    // After term loss, only the next control may recover unfinished work.
    if (config.sharding) config.sharding.pool = data.pool;
    const accounts = data.accounts || new Accounts(new AccountStore(data.pool, data.scope.instanceId));
    if (!data.accounts) lifecycle.defer(await guardStartup(accounts.store, config.authMemorySetting));
    const usage = new UsageService({ pool: data.pool, scope: data.scope, registry: config.registry, budget: config.budget });
    lifecycle.defer(() => usage.pending);
    const warning = pricingWarning(config.registry, config.launch.model, usage.budget);
    if (warning) safeLog(warning);
    for (const warning of config.launch.warnings || []) safeLog(warning);

    // 2. 准备运行目录，由自己的服务自动启动本机 Codex。
    let agent = new AgentDefinition(config.root, config.agentFile);
    agent.repository = data.repository;
    const runtime = await prepareRun(config.launch, config.root, { workspaceDir: agent.workspacePath, instructions: agent.instructions });
    lifecycle.defer(() => finishRun(runtime.runDir));
    agent.configure(config, runtime);
    const baseAgent = agent;
    const localFiles = (data.scope ? createUserFileTools : createFileTools)(config.root, { workspaceDir: runtime.workspaceDir, sources: agent.sources,
      outputs: agent.outputs, assertCurrent: () => { generation?.assert(); baseAgent.assertCurrent(); } });
    const permissionHub = data.pool ? new Hub({ pool: data.pool, instanceId: data.scope.instanceId, usage,
      systemSkills: () => baseAgent.skills,
      catalog: () => [
        { type: 'agent', id: baseAgent.definition.agent.id, planId: path.basename(path.dirname(baseAgent.file)), scope: 'system', owner: null },
        ...fs.readdirSync(path.join(config.root, 'config/tools')).filter(f => f.endsWith('.json')).map(file => {
          const group = JSON.parse(fs.readFileSync(path.join(config.root, 'config/tools', file)));
          return { type: 'tool_group', id: file.replace(/\.json$/, ''), scope: group.scope || 'system', owner: null, tools: group.enabled === false ? [] : group.tools.map(t => t.name) };
        }),
        ...baseAgent.skills.map(skill => ({ ...skill, type: 'skill', scope: 'system', owner: null })),
      ] }) : null;
    const gate = data.scope ? new PermissionGate({ scope: data.scope, agent, permissionHub }) : null;
    lifecycle.defer(() => gate?.close());
    const resources = data.resources?.({ files: localFiles, sources: agent.sources, outputs: agent.outputs, gate });
    const rag = gate ? await createRag(config.rag, path.join(config.root, '.data/knowledge/bm25'), usage) : null;
    const knowledge = gate ? await runOwner(identity(config.root).ownerId, () => new KnowledgeService(data.pool, data.scope, { agent, gate, resources, rag, redact, sharding: config.sharding }).open()) : null;
    if (config.sharding) attachKnowledge({ knowledge, resources, permissionHub, gate }, config.sharding);
    if (knowledge) agent.knowledgeModes = knowledge.modes;
    const files = resources ? { get workspace() { return localFiles.workspace; },
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
    media = data.pool && resources ? new MediaService({ router: config.launch.router, endpoint: config.media?.endpoint,
      store: new MediaJobs(data.pool, data.scope), files: resources, usage, gate, agent, redact, log: safeLog }) : null;
    lifecycle.defer(() => media?.close());
    const boundary = new ExecutionBoundary();
    if (knowledge) knowledge.boundary = boundary;
    // 提议任务的工具在消息服务就绪后才可用；之前调用会明确报错。
    const tasks = { propose: (context, args) => { if (!messages) throw new Error("任务服务尚未就绪。"); return messages.propose(context, args); } };
    const skillReader = { read: (name, file) => agent.readSkill(name, file) };
    const tools = new ToolManager({ config, runtime, files, agent, gate, knowledge, tasks, skills: skillReader, media, boundary, log: safeLog, redact });
    lifecycle.defer(() => tools.close());
    const runtimes = createRuntimes({ config, data, agent, tools, cli, redact, log: safeLog, isolated, permissionHub });
    if (permissionHub) permissionHub.syncSkills = owners => runtimes.syncSkills(owners);
    const rpc = runtimes.rpc;
    engine = rpc;
    // 服务启动与全局工具刷新显式使用配置 Agent。
    await tools.open();
    const hub = new EventHub({ warn: safeLog });
    const sessions = new SessionService({ rpc, config, runtime, hub, redact, tools, boundary, usage, repository: data.repository,
      permissionHub, beforeTurn: () => runtimes.beforeTurn() });
    lifecycle.defer(() => sessions.close());
    tools.attach({ rpc, owners: () => [...sessions.sessions.values()].map(session => session.ownerId), isBusy: () => [...sessions.sessions.values()].some(session => session.activeTurnId), hub });
    const memory = runtimes.memory;
    // 协议、Skill、记忆核验在首次用户请求中完成，启动服务不预占用户进程。
    for (const warning of agent.warnings) safeLog(warning);
    agent = runtimes.agent; config.agent = agent;
    if (gate) gate.agent = agent;
    safeLog(`记忆配置：${config.memory.enabled ? "已开启" : "关闭"}（每用户独立，已开启不代表已生成）。`);
    // 启用门禁时使用 dynamicTools；按正在执行的 Thread / Turn 绑定可信权限上下文。
    if (gate) rpc.on('notification', message => {
      const p = message.params;
      const run = gate.runs.get(p?.threadId);
      if (run && run.context.ownerId !== message.runtimeOwner) return;
      if (message.method === 'turn/started') gate.started(p.threadId, p.turn.id);
      if (message.method === 'turn/completed') gate.end(p.threadId, p.turn.id);
    });
    if (validationOnly) {
      runtimes.attach({ sessions });
      lifecycle.defer(await runtimes.open(error => { safeLog(error.message); void rpc.close(); }));
      const owner = identity(config.root).ownerId;
      return await runOwner(owner, () => runtimes.pool.withOwner(owner, value => ({ config, agent: value.agent, runtime: value.runtime, rpc, sessions, tools, memory, data, resources, gate, knowledge, usage, runtimes, close: () => lifecycle.close() })));
    }
    messages = new MessageService({ rpc, sessions, hub, config, store: data.jobs, queue: data.queue, gate, usage, permissionHub });
    runtimes.attach({ sessions, messages });
    // 单 owner 的 isBusy 查询失败由池记录并跳过；LISTEN 连接断开仍需全局停止。
    lifecycle.defer(await runtimes.open(error => { safeLog(error.message); void messages.fail(error); }));
    lifecycle.defer(async () => {
      await messages.fail(new Error('服务正在关闭，执行结果待核对。'));
      await rpc.close();
      await messages.close();
    });
    generation?.assert();
    await messages.open();
    if (knowledge) knowledge.withOwner = (owner, work) => rpc.withOwner(owner, work);
    if (media) media.withOwner = (owner, work) => permissionHub.withUser(owner, () => rpc.withOwner(owner, work));
    if (knowledge && rag && !validationOnly) {
      knowledge.worker = await new KnowledgeWorker(knowledge, data.queue.commands).open();
      lifecycle.defer(() => knowledge.worker.close());
    }

    if (media) media.sharding = config.sharding;
    if (media?.endpoint) media.open();
    if (databaseFailure) throw databaseFailure;

    const maintenance = new RunMaintenance({ root: config.root, runtime, sessions, log: safeLog });
    lifecycle.defer(() => maintenance.close());
    await maintenance.start();
    safeLog("缓存维护已启用：启动时及每小时检查；保留最近 5 次运行和 7 天内记录，不清理使用中的目录。");

    // 4. HTTP 按登录令牌验证用户；服务发现只发布地址。
    const http = createHttpService({ config, accounts, sessions, messages, hub, redact, tools, memory, data, resources, gate, knowledge, files, usage, permissionHub, log: safeLog });
    lifecycle.defer(() => http.close());
    const url = externalHttp ? `http://${config.host}:${config.port}` : await http.listen();
    if (!externalHttp) publishConnection(config.root, { url }, lifecycle);
    safeLog('业务状态：PostgreSQL；调度：Redis；正文：workspace 与 .data/files；原生历史：各用户 CODEX_HOME。');

    // 5. 就绪；客户端退出不触发这里的服务关闭。
    safeLog(`网络模式：${tools.registry.networkMode === "proxy-debug" ? "本地调试，信任 HTTPS 域名的代理 Fake-IP 映射；生产部署请设置 NODE_ENV=production" : "严格公网地址检查"}`);
    safeLog(`Agent 服务已就绪：${url}\nAgent：${baseAgent.definition.agent.id}\n模型：${config.launch.model || "Codex 默认"}${config.launch.gateway ? "（经本机模型网关）" : ""}\n联网搜索：${config.launch.webSearch === "live" ? "开启（模型自带）" : "关闭"}\n资料目录：${runtime.workspaceDir}\n工具：允许范围已核验；数据层运行使用原生动态工具 + 任务门禁\n工具目录：config/tools/（空闲边界更新；权限契约变化后需新建会话）\n协议日志：${runtime.runDir}/protocol.jsonl\n另开终端运行 npm run chat；此终端 Ctrl+C 停止服务。`);
    generation?.assert();
    const stopDispatch = () => {
      messages.stopping = true; rpc.accepting = false;
      // These methods synchronously abort admission/running signals, then return cleanup promises.
      void rpc.close().catch(() => {});
      void knowledge?.worker?.close().catch(() => {});
      void media?.close().catch(() => {});
    };
    return { http, stopDispatch, config, agent, runtime, rpc, runtimes, sessions, messages, hub, tools, memory, maintenance, data, resources, gate, knowledge, usage, accounts, permissionHub, url, close: gracefulShutdown({
      ...(generation ? { coordinated: true } : {}),
      stopDispatch,
      markUnconfirmed: async () => {
        if (generation) {
          try { await markUnconfirmed(); }
          catch (error) { logFailure(error, { ...generation, log: safeLog }, error, '', 'shutdown-recovery'); }
          finally { generation.active = false; }
        }
        else await messages.fail(new Error("服务正在关闭，执行结果待核对。"));
      },
      close: () => lifecycle.close(),
    }) };
  } catch (error) {
    logFailure(error, { ...generation, log: safeLog }, error, '', 'startup');
    let cleanupFailed = false;
    await lifecycle.close().catch(() => { cleanupFailed = true; });
    throw Object.assign(new Error(redact(error.message)), { cleanupFailed, code: error.code, databaseDiagnostic: error.databaseDiagnostic });
  }
}

export async function main() {
  const { startCoordinatedServer } = await import("./modules/coordination/node.mjs");
  const app = await startCoordinatedServer();
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log("正在关闭服务；待执行消息会保留，未确认的执行不会自动重发。");
    try { await app.close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.exit(process.exitCode || 0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
