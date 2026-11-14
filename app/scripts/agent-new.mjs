import fs from 'node:fs';
import path from 'node:path';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { PROJECT_ROOT, isMain } from './quickstart-lib.mjs';

export const PLACEHOLDER_DESCRIPTION = '请填写这个 Agent 为谁服务、完成什么任务。';
export const PLACEHOLDER_STARTERS = ['请替换为用户常见的第一个请求。', '请替换为用户常见的第二个请求。'];

export const PLACEHOLDER_ROLE = '# 通用助手\n\n<!-- 在这里写服务对象、任务范围、输出要求和遇到不确定情况时的处理方式。不要写密钥，也不要用角色文字扩大工具权限。 -->\n理解用户目标，依据已有资料回答；缺少事实时说明不确定处。需要多步产物时提议 solve-task，确认后执行。只读 inputs/，新产物写入 outputs/；不覆盖已有文件。\n';

export function newAgent(name, { root = PROJECT_ROOT, log = console.log } = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9-]{2,32}$/.test(name)) throw new Error('Agent 名称只允许 2–32 位小写字母、数字和连字符。');
  const directory = path.join(root, 'agents', name);
  if (fs.existsSync(directory)) throw new Error('Agent 目录已存在，请换一个名称。');
  const original = JSON.parse(fs.readFileSync(path.join(root, 'agents/writing/agent.json'), 'utf8'));
  const workflow = { id: 'solve-task', label: '完成任务', skill: 'task-guide', steps: [
    { id: 'clarify', goal: '明确目标与验收要求，向用户确认执行计划', confirm: true },
    { id: 'deliver', goal: '按已确认的要求完成任务，把需要保存的结果写入 outputs/', writes: ['outputs'], checks: ['file-exists', 'format'] },
  ] };
  const definition = { schemaVersion: original.schemaVersion, agent: {
    id: name, name: '通用助手', description: PLACEHOLDER_DESCRIPTION, starters: [...PLACEHOLDER_STARTERS], version: '1.0.0', instructions: 'role.md',
    skills: [{ id: 'task-guide', required: true }],
    tools: { allow: ['list_files', 'read_file', 'write_file', 'skill_read', 'propose_task'] },
    dataBindings: [{ sourceRef: 'inputs', actions: ['read'], methods: ['files'], required: true }],
    executionRef: original.agent.executionRef, memory: { use: false, contribute: false },
    outputs: { directory: 'outputs', formats: ['md', 'txt'], writeMode: 'create-only', requiredChecks: ['file-exists', 'format'] },
    workflows: [workflow],
  }, bindings: {
    workspaceDir: original.bindings.workspaceDir,
    sources: { inputs: { type: 'files', root: 'inputs', readOnly: true } },
    skills: { 'task-guide': { path: 'skills/task-guide/SKILL.md' } },
    executions: { [original.agent.executionRef]: original.bindings.executions[original.agent.executionRef] },
  } };
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, 'skills/task-guide'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'workflows'));
  fs.writeFileSync(path.join(directory, 'agent.json'), JSON.stringify(definition, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'role.md'), PLACEHOLDER_ROLE);
  fs.writeFileSync(path.join(directory, 'skills/task-guide/SKILL.md'), '---\nname: task-guide\ndescription: 明确目标、整理资料并检查交付结果。\n---\n\n<!-- 按业务修改步骤；不要在 Skill 中保存口令或声明额外执行权限。 -->\n1. 核对用户目标与输入资料。\n2. 区分事实与待确认事项。\n3. 完成任务并检查输出是否满足要求。\n');
  fs.writeFileSync(path.join(directory, 'workflows/README.md'), '# 最小工作流示例\n\n<!-- 工作流执行定义在 agent.json 的 agent.workflows；本文件用于说明，不会自动加载。 -->\n\n请替换 agent.json 中 description 和 starters 的占位内容，网页首页会展示；填写一句服务说明和贴合业务的示例请求。\n\nsolve-task 先澄清并确认计划，再按 task-guide 完成任务并检查 outputs/ 产物。修改步骤请编辑 agent.json；writes 只能收窄已有可写范围。\n');
  new AgentDefinition(root, path.join(directory, 'agent.json'));
  log(`Agent 已生成并通过校验。\n运行 npm run agent:use -- ${name}，然后运行 npm run up。`);
  return definition;
}
if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：npm run agent:new -- <name>。');
    newAgent(process.argv[2]);
  } catch (error) { console.error(error.code ? '生成失败，请检查 Agent 目录权限。' : error.message); process.exitCode = 1; }
}
