import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../storage/index.mjs";

const MANIFEST = ".harness-skills.json";

// Agent 包里的 Skill 在启动时同步到 CODEX_HOME/skills（Codex 的 user 范围）。
// 只管理清单里本服务装过的目录：不碰 .system，也不覆盖别人放进来的同名目录。
export function installSkills(agent, codexHome) {
  const root = path.join(codexHome, "skills");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifest = path.join(root, MANIFEST);
  const managed = new Set(readJson(manifest, { skills: [] }).skills.filter(id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)));
  const packaged = agent.skills.filter(skill => skill.source);
  for (const skill of packaged)
    if (fs.existsSync(path.join(root, skill.id)) && !managed.has(skill.id))
      throw new Error(`CODEX_HOME/skills/${skill.id} 已存在且不是本服务安装的，未覆盖。`);
  for (const id of managed)
    if (!packaged.some(skill => skill.id === id)) fs.rmSync(path.join(root, id), { recursive: true, force: true });
  const installed = new Map();
  for (const skill of packaged) {
    const target = path.join(root, skill.id), staging = `${target}.staging`;
    fs.rmSync(staging, { recursive: true, force: true });
    for (const name of skill.files) {
      fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(staging, name), fs.readFileSync(path.join(skill.source, name)), { mode: 0o600 });
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    installed.set(skill.id, fs.realpathSync(path.join(target, "SKILL.md")));
  }
  writeJson(manifest, { skills: packaged.map(skill => skill.id) });
  agent.installedSkills = installed;
  return installed;
}

// 由 Codex 负责解析、发现和注入 Skill；这里仅收紧启用集合并核验依赖。
export async function verifySkills(rpc, agent, workspaceDir) {
  const list = async () => {
    const result = await rpc.request("skills/list", { cwds: [workspaceDir], forceReload: true });
    if (!Array.isArray(result.data)) throw new Error("Codex Skill 清单响应格式无效。");
    return result.data.flatMap(entry => entry.skills || []);
  };
  const canonical = file => { try { return fs.realpathSync(file); } catch { return file; } };
  // Agent 包里的 Skill 以同步后的副本为准：Codex 从 CODEX_HOME 发现它。
  const target = skill => agent.installedSkills?.get(skill.id) || skill.path;
  const requested = new Map(agent.skills.map(skill => [target(skill), skill]));
  let discovered = await list(), changed = false;
  for (const skill of discovered) {
    const enabled = requested.has(canonical(skill.path));
    if (skill.enabled !== enabled) {
      await rpc.request("skills/config/write", { path: skill.path, enabled });
      changed = true;
    }
  }
  if (changed) discovered = await list();
  agent.deniedSkillNames = new Set(discovered.filter(skill => !requested.has(canonical(skill.path))).map(skill => skill.name));
  if (discovered.some(skill => skill.enabled && !requested.has(canonical(skill.path)))) throw new Error("Codex 仍启用了 Agent 范围外的 Skill，已停止执行。");
  const available = [];
  for (const skill of agent.skills) {
    const found = discovered.find(item => canonical(item.path) === target(skill) && item.enabled);
    if (!found) {
      if (skill.required) throw new Error(`Codex 未发现或启用必需 Skill：${skill.id}`);
      continue;
    }
    if (found.dependencies?.tools?.length) throw new Error(`Skill ${skill.id} 声明额外工具依赖，首版尚不支持自动装配。`);
    available.push({ ...skill, path: target(skill), name: found.name });
  }
  if (new Set(available.map(skill => skill.name)).size !== available.length) throw new Error("允许的 Skill 名称重复。");
  return available;
}
