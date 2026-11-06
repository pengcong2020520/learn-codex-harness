import { loadServerConfig, createLogRedactor } from "./modules/config/index.mjs";
import { resolveWorkspace } from "./modules/codex/runtime.mjs";
import { startAgentServer } from "./main.mjs";

let redact = createLogRedactor();
try {
  const config = loadServerConfig();
  redact = createLogRedactor(config.launch.env.CODEX_API_KEY);
  console.log(`配置检查通过；模型：${config.launch.model || "Codex 默认"}；本机端口：${config.port}`);
  if (process.argv.includes("--codex")) {
    config.port = 0;
    const app = await startAgentServer({ config, log: () => {} });
    try {
      const result = await app.rpc.request("model/list", {});
      console.log(redact(`Codex 握手与配置核验通过；模型目录：${result.data.map(item => item.model).join(", ")}`));
    } finally { await app.close(); }
  } else {
    console.log(`工作目录：${await resolveWorkspace(config.root)}\n尚未启动 Codex。`);
  }
  console.log("没有发送模型生成请求；这不代表 API Key 已通过验证。");
} catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
