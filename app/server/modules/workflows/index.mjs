import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { AppError } from "../../../shared/errors.mjs";

// Workflow 只规定边界与终点：本任务额外的授权、注入哪个 Skill、做完后检查什么。
// 怎么拆解、调用哪些工具、调几次，仍由 Codex 的执行循环决定（设计见 docs/skill-workflow-design.md）。
export const CHECKS = Object.freeze(["file-exists", "format", "sources-cited", "wiki-effective"]);
export const GRANT_TYPES = Object.freeze(["knowledge.update"]);
const CHECK_LABELS = { "file-exists": "产物文件存在", format: "产物格式合规", "sources-cited": "产物引用了来源版本", "wiki-effective": "Wiki 修订已生效" };

const BUILTIN = Object.freeze({
  chat: { id: "chat", label: "普通对话" },
  "knowledge-maintain": {
    id: "knowledge-maintain", label: "知识库维护", skill: "knowledge",
    params: { type: "object", required: ["kbId"], additionalProperties: false,
      properties: { kbId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$", description: "要维护的知识库" } } },
    grants: [{ type: "knowledge.update", kbId: { param: "kbId" } }],
    checks: ["wiki-effective"]
  }
});

const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function defineWorkflows(agent) {
  const updatable = new Set((agent.knowledge || []).filter(mount => mount.actions.includes("update")).map(mount => mount.kbId));
  // 没有声明 workflows 的旧定义：挂载了可更新的知识库就隐式启用知识维护，与升级前的行为一致。
  const entries = agent.workflows ?? (updatable.size ? [{ id: "knowledge-maintain" }] : []);
  const ajv = new Ajv({ strict: true, allErrors: false });
  const workflows = new Map([["chat", { ...BUILTIN.chat, validate: null }]]);
  for (const entry of entries) {
    const custom = Object.keys(entry).length > 1;
    if (workflows.has(entry.id)) throw new Error(`Workflow 重复：${entry.id}`);
    if (!custom && !Object.hasOwn(BUILTIN, entry.id)) throw new Error(`未知的内置 Workflow：${entry.id}`);
    if (custom && Object.hasOwn(BUILTIN, entry.id)) throw new Error(`自定义 Workflow 不能与内置的同名：${entry.id}`);
    const workflow = custom ? { label: entry.id, ...entry } : BUILTIN[entry.id];
    // 内置 workflow 的 Skill 可选：Agent 没声明就不注入；自定义 workflow 只能引用已声明的 Skill。
    if (custom && workflow.skill && !agent.skills.some(skill => skill.id === workflow.skill))
      throw new Error(`Workflow ${entry.id} 引用了未声明的 Skill：${workflow.skill}`);
    for (const grant of workflow.grants || []) {
      if (typeof grant.kbId === "string" && !updatable.has(grant.kbId))
        throw new Error(`Workflow ${entry.id} 申请更新知识库 ${grant.kbId}，但 Agent 没有该知识库的 update 权限。`);
      if (typeof grant.kbId === "object" && !(workflow.params?.required || []).includes(grant.kbId.param))
        throw new Error(`Workflow ${entry.id} 的授权引用了未声明为必填的参数：${grant.kbId.param}`);
      if (!updatable.size) throw new Error(`Workflow ${entry.id} 需要可更新的知识库，但 Agent 没有挂载。`);
    }
    workflows.set(entry.id, { ...workflow, validate: workflow.params ? ajv.compile(workflow.params) : null });
  }
  return freeze({
    list: () => [...workflows.values()].map(({ id, label, params, checks }) => ({ id, label, params: params || null, checks: checks || [] })),
    resolve(id = "chat", params = null) {
      const workflow = workflows.get(id);
      if (typeof id !== "string" || !workflow) throw new AppError(`当前 Agent 没有启用这个 Workflow：${id}`, 403, "WORKFLOW_UNAVAILABLE");
      if (params != null && (typeof params !== "object" || Array.isArray(params))) throw new AppError("Workflow 参数必须是对象。", 400);
      if (workflow.validate) {
        if (!workflow.validate(params ?? {})) throw new AppError(`Workflow 参数不合法：${workflow.validate.errors?.[0]?.instancePath || "/"} ${workflow.validate.errors?.[0]?.message || ""}`.trim(), 400);
      } else if (params && Object.keys(params).length) throw new AppError(`Workflow ${id} 不接受参数。`, 400);
      const grants = (workflow.grants || []).map(grant => ({ type: grant.type, kbId: typeof grant.kbId === "object" ? params[grant.kbId.param] : grant.kbId }));
      for (const grant of grants) if (!updatable.has(grant.kbId)) throw new AppError(`Agent 没有更新知识库 ${grant.kbId} 的权限。`, 403, "FORBIDDEN");
      return freeze({ id, label: workflow.label, skill: workflow.skill || null, params: workflow.validate ? { ...params } : null, grants, checks: [...(workflow.checks || [])] });
    }
  });
}

// 给模型的任务说明：只写目标、边界和验收，不写步骤。
export function describe(workflow) {
  if (workflow.id === "chat") return null;
  const lines = [`【工作流】${workflow.label}（${workflow.id}）`];
  if (workflow.params) lines.push(`参数：${JSON.stringify(workflow.params)}`);
  for (const grant of workflow.grants) if (grant.type === "knowledge.update") lines.push(`本任务额外授权：可以更新知识库 ${grant.kbId}`);
  if (workflow.checks.length) lines.push(`完成后服务端检查：${workflow.checks.map(id => CHECK_LABELS[id]).join("、")}`);
  return lines.join("\n");
}

// 验收只看结果：产物、引用、生效的修订；不检查调用过哪些工具或按什么顺序做。
export function runChecks(checks, turn, { workspaceDir, formats = [] } = {}) {
  const artifacts = Object.values(turn.artifacts || {}), revisions = Object.values(turn.revisions || {});
  const result = (id, passed, detail) => ({ id, label: CHECK_LABELS[id], passed, detail });
  return checks.map(id => {
    if (id === "file-exists") {
      const missing = artifacts.filter(artifact => !workspaceDir || !fs.existsSync(path.join(workspaceDir, artifact.locator)));
      return result(id, artifacts.length > 0 && !missing.length, !artifacts.length ? "本轮没有产生产物。" : missing.length ? `文件不存在：${missing.map(a => a.locator).join("、")}` : `${artifacts.length} 个产物`);
    }
    if (id === "format") {
      const wrong = artifacts.filter(artifact => !formats.includes(artifact.format));
      return result(id, artifacts.length > 0 && !wrong.length, !artifacts.length ? "本轮没有产生产物。" : wrong.length ? `格式不在允许范围：${wrong.map(a => a.locator).join("、")}` : formats.join("/"));
    }
    if (id === "sources-cited") {
      const uncited = artifacts.filter(artifact => !(artifact.sources > 0));
      return result(id, artifacts.length > 0 && !uncited.length, !artifacts.length ? "本轮没有产生产物。" : uncited.length ? `没有引用来源版本：${uncited.map(a => a.locator).join("、")}` : "均带来源版本");
    }
    const effective = revisions.filter(revision => revision.effective);
    return result(id, effective.length > 0, effective.length ? effective.map(r => `${r.kbId}/${r.slug}`).join("、") : "本轮没有生效的 Wiki 修订。");
  });
}
