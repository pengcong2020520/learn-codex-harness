import fs from "node:fs";
import path from "node:path";
function resolveSelection(root, value) {
  const file = path.resolve(root, value);
  if (file === path.join(root, "agents/writing/agent.json") && !fs.existsSync(file)) return path.join(root, "examples/writing-assistant/agent.json");
  return file;
}
export function selectAgentFile(root, requested) {
  if (requested) return resolveSelection(root, requested);
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
  return resolveSelection(root, config.agentDefinition);
}
