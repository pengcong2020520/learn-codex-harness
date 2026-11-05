import fs from "node:fs";
import path from "node:path";
import { digest, toolContract } from "./contracts.mjs";
import { readJson, writeJson } from "../storage/index.mjs";
const hashPattern = /^[a-f0-9]{64}$/;
export function readCompatibility(root) {
  const file = path.join(root, ".data/session-compatibility.json");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("会话兼容记录必须是独立文件。");
  }
  const value = readJson(file, { version: 1, aliases: {} });
  if (
    value.version !== 1 ||
    !value.aliases ||
    typeof value.aliases !== "object" ||
    Array.isArray(value.aliases) ||
    Object.entries(value.aliases).some(
      ([from, to]) => !hashPattern.test(from) || !hashPattern.test(to),
    )
  )
    throw new Error("会话兼容记录无效。");
  return value;
}
export function recordCompatibility(root, from, to) {
  if (!hashPattern.test(from) || !hashPattern.test(to))
    throw new Error("描述符 hash 无效。");
  const state = readCompatibility(root);
  state.aliases[from] = to;
  writeJson(path.join(root, ".data/session-compatibility.json"), state);
}
export async function validateLegacyUpgrade(
  previous,
  current,
  { definitionText, toolSnapshot, agent },
) {
  if (!hashPattern.test(previous.hash) || !hashPattern.test(current.hash))
    throw new Error("描述符 hash 无效。");
  const { hash, ...payload } = current;
  if (digest(payload) !== hash) throw new Error("目标描述符完整性校验失败。");
  if (previous.schemaVersion !== "1.0" || current.schemaVersion !== "2.0")
    throw new Error("这里只处理旧全文指纹到兼容契约 v2 的一次性迁移。");
  if (!definitionText || digest(definitionText) !== previous.definitionHash)
    throw new Error("需要与旧 definitionHash 一致的原始 Agent 配置备份。");
  const old = JSON.parse(definitionText),
    { version, instructions, ...effective } = old.agent;
  if (digest(effective) !== current.definitionHash)
    throw new Error("Agent 有效配置已变化，不能复用旧上下文。");
  if (
    digest(old.bindings.knowledgeBases || {}) !==
    digest(agent.definition.bindings.knowledgeBases || {})
  )
    throw new Error("知识目录已变化。");
  for (const key of [
    "agentId",
    "roleHash",
    "tools",
    "skills",
    "workspaceDir",
    "knowledgeModes",
    "outputs",
    "execution",
    "memory",
  ]) {
    if (digest(previous[key] || {}) !== digest(current[key] || {}))
      throw new Error(`会话策略不兼容：${key}`);
  }
  const oldSources = previous.sources.map((s) => ({
    ...s,
    readOnly: s.readOnly ?? s.locator.split("/")[0] === "inputs",
  }));
  if (digest(oldSources) !== digest(current.sources))
    throw new Error("资料范围或只读规则已变化。");
  if (!toolSnapshot) throw new Error("需要对应旧 toolVersion 的运行工具快照。");
  const { readToolSources } = await import("../tools/loader.mjs");
  const source = readToolSources(toolSnapshot);
  if (source.version !== previous.toolVersion)
    throw new Error("旧工具快照 hash 不匹配。");
  // Read definitions only; never import/execute historical plugin implementations.
  const groups = [...source.files]
    .filter(([name]) => name.startsWith(`config${path.sep}tools${path.sep}`))
    .map(([, body]) => JSON.parse(body))
    .filter((g) => g.enabled !== false);
  const contract = toolContract(groups, current.tools);
  if (contract !== current.toolVersion)
    throw new Error("工具参数或授权契约发生变化。");
  return {
    from: previous.hash,
    to: current.hash,
    compatible: true,
    historyAction: "preserve",
    nativeHistoryModified: false,
  };
}
