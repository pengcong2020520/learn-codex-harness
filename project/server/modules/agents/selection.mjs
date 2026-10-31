import fs from "node:fs";
import path from "node:path";
export function selectAgentFile(root, requested) {
  if (requested) return path.resolve(root, requested);
  const file = path.join(root, "config/runtime/project.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    Object.keys(config).join(",") !== "agentDefinition" ||
    typeof config.agentDefinition !== "string" ||
    !config.agentDefinition.trim()
  )
    throw new Error(
      "config/runtime/project.json 必须声明 agentDefinition，或设置 AGENT_DEFINITION。",
    );
  return path.resolve(root, config.agentDefinition);
}
