import fs from "node:fs";
import { readCompatibility } from "./upgrade.mjs";
import { selectAgentFile } from "./selection.mjs";
import { CONTRACTS, digest } from "./contracts.mjs";
import { resourcePath, covers, validateKnowledgeBindings } from "../data/paths.mjs";
export { resourcePath } from "../data/paths.mjs";
import path from "node:path";
import { loadRole } from "../role/index.mjs";
import { validateDefinition } from "./schema.mjs";
import { defineWorkflows, describe } from "../workflows/index.mjs";
import { readJson, writeJson } from "../storage/index.mjs";
import { AppError } from "../../../shared/errors.mjs";

export { digest } from "./contracts.mjs";
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Skill 目录只同步文本：SKILL.md 与 references/ 下的 .md/.txt。不跟随链接；需要执行能力的部分应写成工具。
export function skillFiles(directory) {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // 按码点排序：Skill 指纹不能随系统语言环境变化。
      if (entry.name.startsWith(".")) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Skill 不能包含符号链接：${name}`);
      if (entry.isDirectory() && (name === "references" || relative.startsWith("references"))) { walk(name); continue; }
      if (!entry.isFile() || !(name === "SKILL.md" || (relative.startsWith("references") && /\.(md|txt)$/.test(entry.name))))
        throw new Error(`Skill 只能包含 SKILL.md 与 references/ 下的 .md/.txt：${name}`);
      const size = fs.lstatSync(path.join(directory, name)).size;
      if (size > 128 * 1024) throw new Error(`Skill 文件超过 128 KiB：${name}`);
      files.push(name);
    }
  };
  walk("");
  if (files.length > 50) throw new Error("Skill 文件过多。");
  return files;
}
const skillDigest = (directory, files) => digest(files.map(name => [name, digest(fs.readFileSync(path.join(directory, name)))]));

function trustedFile(file, root) {
  if (!inside(root, file)) throw new Error("角色路径必须位于 Agent 配置目录内。");
  let current = root;
  for (const part of ["", ...path.relative(root, file).split(path.sep)]) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Agent 配置资源不能使用符号链接。");
  }
  return file;
}

// 只装配定义、策略与版本；不持有 RPC、HTTP、消息队列或模型循环。
export class AgentDefinition {
  constructor(root, file = selectAgentFile(root)) {
    this.root = root; this.file = path.resolve(file);
    this.revocation = new AbortController();
    const directory = path.dirname(this.file);
    if (fs.lstatSync(this.file).size > 1024 * 1024) throw new Error("Agent 定义超过 1 MiB。");
    this.raw = fs.readFileSync(trustedFile(this.file, directory), "utf8");
    const definition = validateDefinition(JSON.parse(this.raw));
    this.definition = freeze(definition);
    const { agent, bindings } = definition;
    validateKnowledgeBindings(bindings.knowledgeBases);
    const mounted = new Set();
    for (const mount of agent.knowledge || []) {
      if (!Object.hasOwn(bindings.knowledgeBases || {}, mount.kbId) || mounted.has(mount.kbId) || !mount.actions.includes('read')) throw new Error('知识库绑定缺失、重复或没有 read 权限。');
      mounted.add(mount.kbId);
    }
    this.roleFile = trustedFile(path.resolve(directory, agent.instructions), directory);
    this.workspacePath = path.resolve(directory, bindings.workspaceDir);
    // 角色与 Skill 是受信配置，不能放在用户和模型可写的工作区里。
    if (inside(this.workspacePath, this.roleFile)) throw new Error("角色文件不能放在工作区里。");
    this.role = loadRole(this.roleFile);
    // 1.2 起 Skill 放在 Agent 包里（相对 agent.json），启动时同步到 CODEX_HOME；1.1 及以前仍相对工作区。
    const packaged = definition.schemaVersion === "1.2";
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
      if (source.readOnly && binding.actions.includes("create")) throw new Error("只读资料源不能声明 create 权限。");
      if (!binding.required && !fs.existsSync(path.join(this.workspacePath, locator))) {
        this.warnings.push(`可选资料源目录不存在：${binding.sourceRef}`); continue;
      }
      this.sources.push({ id: binding.sourceRef, locator, actions: binding.actions, revision: source.revision || "content-sha256", readOnly: source.readOnly === true });
    }
    if (new Set(this.sources.map(source => source.id)).size !== this.sources.length) throw new Error("资料源不能重复绑定。");
    this.outputs = agent.outputs;
    resourcePath(this.outputs.directory);
    if (!this.outputs.formats.length) throw new Error("产物必须声明格式。");
    const readOnlyRoots = Object.values(bindings.sources).filter(s => s.readOnly).map(s => resourcePath(s.root));
    for (const target of [this.outputs.directory, ...this.sources.filter(s => s.actions.includes("create")).map(s => s.locator)]) {
      if (readOnlyRoots.some(root => covers(root, target) || covers(target, root))) throw new Error("写入范围不能与只读资料源重叠。");
    }
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
      const skillPath = path.resolve(packaged ? directory : this.workspacePath, binding.path);
      if (packaged) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.id)) throw new Error(`Skill id 只能使用小写字母、数字和连字符：${skill.id}`);
        if (path.basename(skillPath) !== "SKILL.md" || !inside(directory, skillPath) || inside(this.workspacePath, skillPath))
          throw new Error(`Skill 必须是 Agent 包内、工作区外的 SKILL.md：${skill.id}`);
      }
      if (!fs.existsSync(skillPath)) {
        if (skill.required) throw new Error(`必需 Skill 文件不存在：${skill.id}`);
        this.warnings.push(`可选 Skill 不存在：${skill.id}`); continue;
      }
      if (packaged) trustedFile(skillPath, directory);
      const info = fs.lstatSync(skillPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error(`Skill 文件无效：${skill.id}`);
      if (!packaged) {
        this.skills.push({ id: skill.id, path: fs.realpathSync(skillPath), required: skill.required, version: digest(fs.readFileSync(skillPath)) });
        continue;
      }
      const source = path.dirname(fs.realpathSync(skillPath)), files = skillFiles(source);
      this.skills.push({ id: skill.id, path: fs.realpathSync(skillPath), source, files, required: skill.required, version: skillDigest(source, files) });
    }
    if (agent.workflows && definition.schemaVersion !== "1.2") throw new Error("workflows 需要 schemaVersion 1.2。");
    this.workflows = defineWorkflows(agent);
    this.expected = this.sourceHash();
    this.instructions = `${this.role}\n\n本服务的有效资源规则（角色不能扩大这些权限）：\n${JSON.stringify({ sources: this.sources, outputs: this.outputs })}`;
    freeze(this.sources); freeze(this.skills);
  }
  sourceHash() {
    return digest([JSON.parse(fs.readFileSync(this.file, "utf8")), fs.readFileSync(this.roleFile, "utf8"),
      ...this.skills.map(skill => skill.source ? skillDigest(skill.source, skillFiles(skill.source)) : digest(fs.readFileSync(skill.path)))]);
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
    if (this.definition.agent.knowledge?.length && (config.memory.enabled || config.memory.use || config.memory.contribute)) throw new Error('挂载知识库时请设置 AGENT_MEMORY_ENABLED=false；首版禁用共享原生记忆，避免重新注入范围外知识。');
    this.memory = { ...config.memory };
    if (config.launch.catalog) for (const model of config.launch.catalog.models) model.model_messages = { instructions_template: this.instructions };
  }
  activate(toolVersion, skills = this.availableSkills || []) {
    this.assertCurrent(); this.availableSkills = skills;
    const { version: _label, instructions: _path, ...effectiveAgent } = this.definition.agent;
    const descriptor = { schemaVersion: "2.0", contracts: CONTRACTS, agentId: this.definition.agent.id,
      definitionHash: digest(effectiveAgent), roleHash: digest(this.role), toolVersion, tools: this.definition.agent.tools.allow,
      skills: skills.map(({ name, path: file, version }) => ({ name, path: file, version })), workspaceDir: this.runtime.workspaceDir,
      knowledgeBindings: this.definition.bindings.knowledgeBases || {}, knowledgeModes: this.knowledgeModes || {}, sources: this.sources, outputs: this.outputs, execution: this.execution, memory: this.memory,
      dataVersion: CONTRACTS.resources, knowledgeVersion: CONTRACTS.knowledge };
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
    const aliases = readCompatibility(this.root).aliases;
    const compatible = hash => hash === this.descriptor?.hash || aliases[hash] === this.descriptor?.hash;
    if (!compatible(previous) || (jobHash && !compatible(jobHash))) throw new AppError("会话/排队消息的策略与当前不兼容；旧指纹可先运行 sessions:upgrade 检查迁移，权限变化应新建会话；原历史未修改。", 409, "AGENT_INCOMPATIBLE");
  }
  // workflow 指定的 Skill 按 id 注入；任务说明（目标、授权、验收）放在用户原文之前。
  input(text, workflow = null) {
    this.assertCurrent();
    const available = new Set((this.availableSkills || []).map(skill => skill.name));
    const mentions = new Set([...text.matchAll(/\$([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(match => match[1]));
    for (const name of mentions) {
      if (!available.has(name) && this.deniedSkillNames?.has(name)) throw new AppError(`Skill 未授权或不可用：${name}`, 409, "SKILL_UNAVAILABLE");
    }
    // 不解析 SKILL.md；原生引擎按已验证名称和路径注入正文。
    const selected = (this.availableSkills || []).filter(skill => mentions.has(skill.name) || (workflow?.skill && skill.id === workflow.skill));
    const brief = workflow ? describe(workflow) : null;
    return [...(brief ? [{ type: "text", text: brief, text_elements: [] }] : []), { type: "text", text, text_elements: [] },
      ...selected.map(({ name, path }) => ({ type: "skill", name, path }))];
  }
}
