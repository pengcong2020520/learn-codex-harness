import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { toolContract } from "../agents/contracts.mjs";
import { AgentDefinition } from "../agents/index.mjs";
import { createFileTools } from "../data/files.mjs";

// 配置和实现都是部署者信任的代码，不从 workspace、网页或模型输出加载。
export function readToolSources(root) {
  const files = new Map();
  function collect(relative, extension) {
    const directory = path.join(root, relative);
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("工具目录不能是符号链接。");
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith(".")) continue;
      const name = path.join(relative, item.name);
      if (item.isSymbolicLink()) throw new Error("工具目录不接受符号链接。");
      if (item.isDirectory()) { collect(name, extension); continue; }
      if (!item.isFile() || !name.endsWith(extension)) continue;
      const body = fs.readFileSync(path.join(root, name));
      if (body.length > 1024 * 1024 || files.size >= 200) throw new Error("工具目录过大。");
      files.set(name, body);
    }
  }
  collect("config/tools", ".json");
  collect("server/modules/tools", ".mjs");
  const hash = createHash("sha256");
  for (const [name, body] of files) hash.update(name).update("\0").update(body).update("\0");
  return { files, version: hash.digest("hex") };
}

export async function createToolService(root, { source = readToolSources(root), snapshotDir, nodeEnv = "development", runWeb, files, agent, gate, knowledge, tasks, workspaceDir } = {}) {
  const policy = files ? null : agent || new AgentDefinition(root);
  const fileService = files || createFileTools(root, { workspaceDir: workspaceDir || policy.workspacePath, sources: policy.sources, outputs: policy.outputs });
  const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
  const entries = new Map(), groups = [];
  // 接受工具删除/禁用后立即收紧旧快照，回滚实现不会恢复已经撤销的入口。
  const currentNames = () => {
    if (!agent) return null;
    agent.assertCurrent();
    const names = new Set();
    const current = readToolSources(root);
    for (const [file, body] of current.files) {
      if (!file.startsWith(`config${path.sep}tools${path.sep}`)) continue;
      const config = JSON.parse(body);
      if (config.enabled === false) continue;
      for (const spec of config.tools || []) names.add(spec.name);
    }
    return names;
  };
  for (const [file, body] of source.files) {
    if (!file.startsWith(`config${path.sep}tools${path.sep}`)) continue;
    let config;
    try { config = JSON.parse(body); } catch { throw new Error(`工具配置 JSON 无效：${path.basename(file)}`); }
    if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key => !["enabled", "module", "factory", "tools", "contractVersion"].includes(key)) ||
      (config.enabled !== undefined && typeof config.enabled !== "boolean")) throw new Error(`工具配置字段无效：${path.basename(file)}`);
    if (config.enabled === false) continue;
    if (config.contractVersion !== undefined && (!Number.isSafeInteger(config.contractVersion) || config.contractVersion < 1)) throw new Error("工具 contractVersion 必须为正整数。");
    if (typeof config.module !== "string" || !config.module.startsWith("server/modules/tools/") ||
      config.module.split("/").some(part => !part || part.startsWith(".")) || !source.files.has(config.module)) throw new Error(`工具模块必须位于 server/modules/tools：${path.basename(file)}`);
    if (!Array.isArray(config.tools)) throw new Error(`缺少 tools 数组：${path.basename(file)}`);
    for (const spec of config.tools) {
      if (!spec || typeof spec.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(spec.name) || typeof spec.description !== "string" || !spec.description.trim() ||
        typeof spec.label !== "string" || typeof spec.readOnly !== "boolean" || spec.inputSchema?.type !== "object" ||
        Object.keys(spec).some(key => !["name", "label", "description", "readOnly", "inputSchema"].includes(key))) throw new Error(`工具定义无效：${path.basename(file)}`);
      if (entries.has(spec.name)) throw new Error(`工具重名：${spec.name}`);
      entries.set(spec.name, { spec, validate: ajv.compile(spec.inputSchema) });
    }
    groups.push(config);
  }
  if (snapshotDir) {
    for (const [file, body] of source.files) {
      const target = path.join(snapshotDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, body, { mode: 0o600, flag: "wx" });
    }
  }
  // 每版独立路径，连同相对依赖一起刷新，避免 ESM 缓存继续执行旧代码。
  const moduleRoot = snapshotDir || root;
  for (const group of groups) {
    if (agent && !group.tools.some(tool => agent.allowsTool(tool.name))) continue;
    const module = await import(pathToFileURL(path.join(moduleRoot, group.module)).href);
    const factory = module[group.factory || "createTools"];
    if (typeof factory !== "function") throw new Error(`工具模块没有工厂函数：${group.module}`);
    const handlers = await factory({ root, nodeEnv, runWeb, files: fileService, knowledge, tasks });
    for (const { name } of group.tools) {
      if (!Object.hasOwn(handlers, name) || typeof handlers[name] !== "function") throw new Error(`缺少工具执行函数：${name}`);
      entries.get(name).execute = handlers[name];
    }
  }
  for (const name of agent?.definition.agent.tools.allow || []) if (!entries.has(name)) throw new Error(`Agent 允许的必需工具未注册：${name}`);
  const specs = [...entries.values()].filter(({ spec }) => !agent || agent.allowsTool(spec.name)).map(({ spec }) => ({
    name: spec.name, title: spec.label, description: spec.description, inputSchema: spec.inputSchema,
    annotations: { readOnlyHint: spec.readOnly }
  }));
  return {
    compatibilityVersion: toolContract(groups, agent?.definition.agent.tools.allow),
    version: source.version, get specs() { const names = currentNames(); return names ? specs.filter(spec => names.has(spec.name)) : specs; }, workspace: fileService.workspace, networkMode: nodeEnv === "production" ? "strict" : "proxy-debug",
    label: name => entries.get(name)?.spec.label || name,
    validate(name, args) {
      const entry = entries.get(name);
      if (!entry || (agent && (!agent.allowsTool(name) || !currentNames().has(name)))) throw new Error("未授权的工具。");
      if (!entry.validate(args)) throw new Error(`工具参数不合法：${entry.validate.errors?.[0]?.message || "请检查参数"}`);
      return entry;
    },
    async call({ tool, namespace, arguments: args }, { signal, permissionContext } = {}) {
      if (agent) signal = AbortSignal.any([agent.revocation.signal, ...(signal ? [signal] : [])]);
      try {
        signal?.throwIfAborted();
        if (namespace != null) throw new Error("未授权的工具命名空间。");
        const entry = this.validate(tool, args);
        const execute = async () => {
          gate?.check('tool.call', { name: tool });
          const trusted = gate?.current();
          const context = trusted ? Object.freeze({ userId: trusted.userId, threadId: trusted.threadId, turnId: trusted.turnId,
            taskId: trusted.taskId || null, agentId: trusted.agentId }) : null;
          if (gate && (trusted.kind !== 'task' || !context.userId || !context.threadId || !context.turnId)) throw new Error('工具调用缺少可信用户、会话或轮次身份。');
          const executionSignal = trusted?.signal ? AbortSignal.any([trusted.signal, ...(signal ? [signal] : [])]) : signal;
          const value = await entry.execute(args, { signal: executionSignal, context });
          gate?.current(); signal?.throwIfAborted(); return value;
        };
        const data = gate ? await gate.run(permissionContext, execute, signal) : await execute();
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data ?? null) }] };
      } catch (error) {
        const message = error.code === "ENOENT" ? "文件或目录不存在。" : error.code === "ENOTDIR" ? "指定路径不是目录。"
          : error.code === "EACCES" ? "没有访问该文件的权限。" : signal?.aborted ? "工具调用已取消。"
          : /^E[A-Z]+$/.test(error.code || "") ? `工具操作失败（${error.code}）。` : error.message;
        return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ error: message, ...(error.code ? { code: error.code } : {}) }) }] };
      }
    }
  };
}
