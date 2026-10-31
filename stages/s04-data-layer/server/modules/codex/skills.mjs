import fs from "node:fs";

// 由 Codex 负责解析、发现和注入 Skill；这里仅收紧启用集合并核验依赖。
export async function verifySkills(rpc, agent, workspaceDir) {
  const list = async () => {
    const result = await rpc.request("skills/list", { cwds: [workspaceDir], forceReload: true });
    if (!Array.isArray(result.data)) throw new Error("Codex Skill 清单响应格式无效。");
    return result.data.flatMap(entry => entry.skills || []);
  };
  const canonical = file => { try { return fs.realpathSync(file); } catch { return file; } };
  const requested = new Map(agent.skills.map(skill => [skill.path, skill]));
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
    const found = discovered.find(item => canonical(item.path) === skill.path && item.enabled);
    if (!found) {
      if (skill.required) throw new Error(`Codex 未发现或启用必需 Skill：${skill.id}`);
      continue;
    }
    if (found.dependencies?.tools?.length) throw new Error(`Skill ${skill.id} 声明额外工具依赖，首版尚不支持自动装配。`);
    available.push({ ...skill, name: found.name });
  }
  if (new Set(available.map(skill => skill.name)).size !== available.length) throw new Error("允许的 Skill 名称重复。");
  return available;
}
