import fs from 'node:fs';
import path from 'node:path';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { validateDefinition } from '../server/modules/agents/schema.mjs';
import { loadRole } from '../server/modules/role/index.mjs';
import { loadModelRegistry } from '../server/modules/gateway/index.mjs';
import { createModelRouter, validateEffort } from '../server/modules/gateway/router.mjs';
import { PLACEHOLDER_ROLE } from './agent-new.mjs';
import { PROJECT_ROOT, isMain } from './quickstart-lib.mjs';

// 仅检查约定的顶层字段是否存在，不解释 YAML，也不加载 Skill 内容为代码。
export function hasSkillMetadata(text) {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return header !== undefined && ['name', 'description'].every(key => {
    const value = header.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim();
    return value && !/^(?:#.*|''|""|null|~)$/.test(value);
  });
}

function resourceFile(directory, relative) {
  const file = path.resolve(directory, relative);
  if (!file.startsWith(directory + path.sep)) throw new Error('资源必须在配置目录内。');
  let current = directory;
  for (const part of ['', ...path.relative(directory, file).split(path.sep)]) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('资源不能是符号链接。');
  }
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) throw new Error('资源文件无效。');
  return file;
}

export function checkAgent(requested, { root = PROJECT_ROOT } = {}) {
  const rows = [], file = path.resolve(root, requested || ''), directory = path.dirname(file);
  const label = path.relative(root, file) || 'agent.json';
  const add = (level, field, detail, fix) => rows.push({ id: `agent-${rows.length}`, level, title: `${label} · ${field}`, detail, fix });
  let definition;
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error();
    definition = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    add('error', '/', '无法读取 Agent 定义。', '提供普通的 agent.json 文件，检查路径、读取权限和 JSON 语法。');
    return rows;
  }
  try { validateDefinition(definition); }
  catch (error) {
    // 位置来自现有 schema 的诊断，不复制字段规则，也不回显无效字段的值。
    const fields = [...new Set(error.message.match(/\/[A-Za-z0-9_/-]+/g) || ['/'])];
    for (const field of fields) add('error', field, '字段不符合 AgentDefinition 结构规则。', field.includes('/outputs/formats')
      ? 'outputs.formats 请使用 md、txt、html、png、jpeg、webp、mp4 中的格式。'
      : '对照 README「做你自己的 Agent」及 agents/writing/agent.json 修正此字段的类型、必填项和取值。');
    return rows;
  }
  const { agent, bindings } = definition;
  try {
    const role = loadRole(resourceFile(directory, agent.instructions));
    if (role === PLACEHOLDER_ROLE.trim()) add('warning', 'agent.instructions', '角色仍是占位文字。', '编辑角色文件，填写服务对象、任务范围和交付要求。');
  } catch { add('error', 'agent.instructions', '角色文件不存在、为空或不是有效的独立文本文件。', '在 Agent 包内创建非空角色文件，并修正 instructions 的相对路径。'); }
  const available = new Set();
  for (const skill of agent.skills) {
    const field = `bindings.skills.${skill.id}.path`, binding = bindings.skills?.[skill.id];
    try {
      if (!binding || path.basename(binding.path) !== 'SKILL.md') throw new Error();
      const base = definition.schemaVersion === '1.2' ? directory : path.resolve(directory, bindings.workspaceDir);
      const skillFile = resourceFile(base, binding.path);
      if (!hasSkillMetadata(fs.readFileSync(skillFile, 'utf8'))) {
        add('error', `${field} · SKILL.md frontmatter`, 'Skill 缺少名称或描述。', '在 SKILL.md 开头的 --- frontmatter 中填写非空 name 和 description。');
      } else available.add(skill.id);
    } catch { add('error', field, 'Skill 文件不存在或路径无效。', '在绑定路径创建 SKILL.md 普通文件，并同时核对 agent.skills 与 bindings.skills。'); }
  }
  let router;
  try {
    const registry = loadModelRegistry(root);
    if (!registry) throw new Error();
    // 静态检查不读密钥；只验证清单声明的用途与能力，不代表服务商可用。
    router = createModelRouter(registry, { AGENT_ENABLED_PROVIDERS: Object.keys(registry.providers).join(',') });
  } catch { add('error', 'config/models.json', '模型目录缺失或无效。', '修正 config/models.json 的结构与模型引用后重新检查。'); }
  for (const [index, workflow] of (agent.workflows || []).entries()) {
    const field = `agent.workflows[${index}]`;
    if (workflow.skill && !available.has(workflow.skill)) add('error', `${field}.skill`, '工作流引用的 Skill 不可用。', '把 Skill 同时登记到 agent.skills 和 bindings.skills，并补齐有效的 SKILL.md。');
    for (const [stepIndex, step] of (workflow.steps || []).entries()) {
      if (!router || (!step.model && !step.needs && !step.effort)) continue;
      try { validateEffort(router.resolve({ model: step.model, needs: step.needs }), step.effort); }
      catch { add('error', `${field}.steps[${stepIndex}].model`, '步骤模型或所需能力不可用。', '在 config/models.json 中选择用途含 chat 的模型或场景；看图要求 inputs 含 image，同时核对 needs 与 effort。'); }
    }
  }
  for (const [index, binding] of agent.dataBindings.entries()) {
    const source = bindings.sources[binding.sourceRef];
    if (!source) continue;
    try {
      if (!fs.statSync(path.resolve(directory, bindings.workspaceDir, source.root)).isDirectory()) throw new Error();
    } catch { add('warning', `agent.dataBindings[${index}] · bindings.sources.${binding.sourceRef}.root`, '资料目录不存在或不可读取，可能尚未部署资料。', '核对相对于 workspaceDir 的目录，在部署或导入资料后重新检查。'); }
  }
  // 保留运行时的全部权限、路径、工作流与依赖校验；语义检查仅补充定位信息。
  try { new AgentDefinition(root, file); }
  catch {
    if (!rows.some(row => row.level === 'error')) add('error', 'agent / bindings', 'AgentDefinition 装配校验失败。', '对照 README「做你自己的 Agent」核对绑定、资源路径、工具与写入范围、Skill 依赖和工作流定义。');
  }
  return rows;
}

export function formatAgentChecks(rows) {
  return [...rows.map(row => `${row.level === 'error' ? '错误' : '建议'}：${row.title}\n  ${row.detail} 怎么改：${row.fix}`),
    rows.some(row => row.level === 'error') ? 'Agent 检查未通过。' : 'Agent 错误级检查通过。',
    '仅做静态检查；未连接数据库、Codex 或模型服务。'].join('\n');
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('用法：npm run agent:check -- <agent.json 路径>。'); process.exitCode = 1; }
  else {
    const rows = checkAgent(process.argv[2]);
    console.log(formatAgentChecks(rows));
    if (rows.some(row => row.level === 'error')) process.exitCode = 1;
  }
}
