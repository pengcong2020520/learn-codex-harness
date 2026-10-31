import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadRole } from "../role/index.mjs";
import { validateDefinition } from "./schema.mjs";
import { readJson, writeJson } from "../storage/index.mjs";
import { AppError } from "../../../shared/errors.mjs";

export const digest = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function trustedFile(file, root) {
  if (!inside(root, file)) throw new Error("角色路径必须位于 Agent 配置目录内。");
  let current = root;
  for (const part of ["", ...path.relative(root, file).split(path.sep)]) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Agent 配置资源不能使用符号链接。");
  }
  return file;
}

export function resourcePath(value) {
  if (typeof value !== "string" || value.length > 500 || /[\\\x00-\x1f\x7f:]/.test(value) ||
      path.isAbsolute(value) || value.split("/").some(part => !part || part.startsWith(".")) ||
      !["inputs", "research", "drafts", "outputs"].includes(value.split("/")[0])) throw new Error("资料/产物路径必须位于 inputs、research、drafts、outputs 内，不能包含上级或隐藏目录。");
  return value;
}

// 只装配定义、策略与版本；不持有 RPC、HTTP、消息队列或模型循环。
export class AgentDefinition {
  constructor(root, file = path.join(root, "agents/writing-agent.json")) {
    this.root = root; this.file = path.resolve(file);
    this.revocation = new AbortController();
    const directory = path.dirname(this.file);
    if (fs.lstatSync(this.file).size > 1024 * 1024) throw new Error("Agent 定义超过 1 MiB。");
    this.raw = fs.readFileSync(trustedFile(this.file, directory), "utf8");
    const definition = validateDefinition(JSON.parse(this.raw));
    this.definition = freeze(definition);
    const { agent, bindings } = definition;
    this.roleFile = trustedFile(path.resolve(directory, agent.instructions), directory);
    this.role = loadRole(this.roleFile);
    this.workspacePath = path.resolve(directory, bindings.workspaceDir);
    this.execution = Object.hasOwn(bindings.executions, agent.executionRef) ? bindings.executions[agent.executionRef] : null;
    if (!this.execution) throw new Error(`缺少执行策略：${agent.executionRef}`);
    this.warnings = []; this.skills = []; this.sources = [];
    for (const binding of agent.dataBindings) {
      const source = Object.hasOwn(bindings.sources, binding.sourceRef) ? bindings.sources[binding.sourceRef] : null;
      if (!source) {
        if (binding.required) throw new Error(`缺少必需资料源：${binding.sourceRef}`);
        this.warnings.push(`可选资料源不可用：${binding.sourceRef}`); continue;
      }
      const locator = resourcePath(source.root);
      if (!binding.methods.includes("files") || !binding.actions.length) throw new Error(`资料源缺少可执行的文件方法或动作：${binding.sourceRef}`);
      if (locator.split("/")[0] === "inputs" && binding.actions.includes("create")) throw new Error("原始 inputs 资料只能读取。");
      if (!binding.required && !fs.existsSync(path.join(this.workspacePath, locator))) {
        this.warnings.push(`可选资料源目录不存在：${binding.sourceRef}`); continue;
      }
      this.sources.push({ id: binding.sourceRef, locator, actions: binding.actions, revision: source.revision || "content-sha256" });
    }
    if (new Set(this.sources.map(source => source.id)).size !== this.sources.length) throw new Error("资料源不能重复绑定。");
    this.outputs = agent.outputs;
    if (resourcePath(this.outputs.directory).split("/")[0] === "inputs" || !this.outputs.formats.length) throw new Error("产物不能写入 inputs，且必须声明格式。");
    if (new Set(agent.skills.map(skill => skill.id)).size !== agent.skills.length) throw new Error("Skill 不能重复绑定。");
    for (const skill of agent.skills) {
      const binding = Object.hasOwn(bindings.skills || {}, skill.id) ? bindings.skills[skill.id] : null;
      if (!binding) {
        if (skill.required) throw new Error(`缺少必需 Skill 绑定：${skill.id}`);
        this.warnings.push(`可选 Skill 未绑定：${skill.id}`); continue;
      }
      // 首版支持原生文本 Skill；需脚本/外部资产的技能明确阻塞，不偷偷开放 shell。
      if (binding.requires?.length) {
        if (skill.required) throw new Error(`Skill ${skill.id} 的依赖尚未支持：${binding.requires.join(", ")}`);
        this.warnings.push(`可选 Skill 依赖未满足：${skill.id}`); continue;
      }
      const skillPath = path.resolve(this.workspacePath, binding.path);
      if (!fs.existsSync(skillPath)) {
        if (skill.required) throw new Error(`必需 Skill 文件不存在：${skill.id}`);
        this.warnings.push(`可选 Skill 不存在：${skill.id}`); continue;
      }
      const info = fs.lstatSync(skillPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error(`Skill 文件无效：${skill.id}`);
      this.skills.push({ id: skill.id, path: fs.realpathSync(skillPath), required: skill.required, version: digest(fs.readFileSync(skillPath)) });
    }
    this.expected = this.sourceHash();
    this.instructions = `${this.role}\n\n本服务的有效资源规则（角色不能扩大这些权限）：\n${JSON.stringify({ sources: this.sources, outputs: this.outputs })}`;
    freeze(this.sources); freeze(this.skills);
  }
  sourceHash() {
    return digest([fs.readFileSync(this.file, "utf8"), fs.readFileSync(this.roleFile, "utf8"),
      ...this.skills.map(skill => digest(fs.readFileSync(skill.path)))]);
  }
  assertCurrent() {
    try { if (this.sourceHash() !== this.expected) this.revoked = true; } catch { this.revoked = true; }
    if (this.revoked) {
      const error = new AppError("Agent 定义、角色或 Skill 已变更；后续调用已停止，请受控重启服务后新建会话。", 409, "AGENT_CHANGED");
      this.revocation.abort(error); throw error;
    }
  }
  allowsTool(name) { this.assertCurrent(); return this.definition.agent.tools.allow.includes(name); }
  configure(config, runtime) {
    this.runtime = runtime;
    config.agent = this;
    config.memory = { ...config.memory, use: config.memory.use && this.definition.agent.memory.use,
      contribute: config.memory.enabled && this.definition.agent.memory.contribute };
    this.memory = { ...config.memory };
    if (config.launch.catalog) for (const model of config.launch.catalog.models) model.model_messages = { instructions_template: this.instructions };
  }
  activate(toolVersion, skills = this.availableSkills || []) {
    this.assertCurrent(); this.availableSkills = skills;
    const descriptor = { schemaVersion: "1.0", agentId: this.definition.agent.id, agentVersion: this.definition.agent.version,
      definitionHash: digest(this.raw), roleHash: digest(this.role), toolVersion, tools: this.definition.agent.tools.allow,
      skills: skills.map(({ name, path: file, version }) => ({ name, path: file, version })), workspaceDir: this.runtime.workspaceDir,
      sources: this.sources, outputs: this.outputs, execution: this.execution, memory: this.memory,
      dataVersion: digest(['files.mjs', 'resources.mjs', 'schema.sql'].map(name =>
        digest(fs.readFileSync(new URL(`../data/${name}`, import.meta.url))))) };
    this.descriptor = freeze({ ...descriptor, hash: digest(descriptor) });
    if (this.repository) return this.repository.saveAgent(this.descriptor);
    writeJson(path.join(this.root, ".data/agent-descriptors", `${this.descriptor.hash}.json`), this.descriptor);
  }
  get bindingsFile() { return path.join(this.root, ".data/thread-agents.json"); }
  bind(threadId) {
    if (!this.descriptor) throw new Error("Agent 尚未完成能力核验。");
    if (this.repository) return this.repository.bind(threadId, this.descriptor.hash, this.runtime.workspaceDir);
    const bindings = readJson(this.bindingsFile, {});
    if (Object.hasOwn(bindings, threadId) && bindings[threadId] !== this.descriptor.hash) this.assertCompatible(threadId);
    bindings[threadId] = this.descriptor.hash; writeJson(this.bindingsFile, bindings);
  }
  assertCompatible(threadId, jobHash) {
    this.assertCurrent();
    if (this.repository) return this.repository.conversation(threadId).then(row => this.checkBinding(row.agent_hash, jobHash));
    const previous = readJson(this.bindingsFile, {})[threadId];
    this.checkBinding(previous, jobHash);
  }
  checkBinding(previous, jobHash) {
    if (!previous) throw new AppError("旧会话没有 Agent 版本绑定，历史已保留；本版不自动迁移权限，请新建会话。", 409, "LEGACY_THREAD");
    if (previous !== this.descriptor?.hash || (jobHash && jobHash !== previous)) throw new AppError("会话/排队消息的 Agent 版本与当前不兼容，请新建会话；原历史未修改。", 409, "AGENT_INCOMPATIBLE");
  }
  input(text) {
    this.assertCurrent();
    const available = new Set((this.availableSkills || []).map(skill => skill.name));
    const mentions = new Set([...text.matchAll(/\$([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(match => match[1]));
    for (const name of mentions) {
      if (!available.has(name) && this.deniedSkillNames?.has(name)) throw new AppError(`Skill 未授权或不可用：${name}`, 409, "SKILL_UNAVAILABLE");
    }
    // 不解析 SKILL.md；原生引擎按已验证名称和路径注入正文。
    const selected = (this.availableSkills || []).filter(skill => mentions.has(skill.name));
    return [{ type: "text", text, text_elements: [] }, ...selected.map(({ name, path }) => ({ type: "skill", name, path }))];
  }
}
