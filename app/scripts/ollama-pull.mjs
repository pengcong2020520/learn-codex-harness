// 下载模型清单里登记的 Ollama 模型（compose 的 ollama 服务要先启动：npm run ollama:up）。
// npm run ollama:pull
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadModelRegistry, splitModelId } from "../server/modules/gateway/index.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const registry = loadModelRegistry(root);
const models = Object.keys(registry?.models || {}).filter(id => registry.providers[splitModelId(id).provider]?.type === "ollama").map(id => splitModelId(id).model);
if (!models.length) { console.log("config/models.json 里没有登记 Ollama 模型。"); process.exit(0); }
for (const model of models) {
  console.log(`下载 ${model} ……`);
  const result = spawnSync("docker", ["compose", "exec", "-T", "ollama", "ollama", "pull", model], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) { console.error(`下载 ${model} 失败；确认已运行 npm run ollama:up。`); process.exit(result.status || 1); }
}
console.log(`已下载：${models.join("、")}`);
