import { loadServerConfig, createLogRedactor } from "./modules/config/index.mjs";
import { resolveWorkspace } from "./modules/codex/runtime.mjs";
import { createToolService } from "./modules/tools/loader.mjs";
import { AgentDefinition } from "./modules/agents/index.mjs";
import { createFileTools } from "./modules/data/files.mjs";
import { startAgentServer } from "./main.mjs";

let redact = createLogRedactor();
try {
  const config = loadServerConfig();
  redact = createLogRedactor(config.launch.env.CODEX_API_KEY);
  if (process.argv.includes("--codex")) {
    config.port = 0;
    const app = await startAgentServer({ config, validationOnly: true, log: () => {} });
    try {
      console.log(`已核验的兼容描述符：${app.agent.descriptor.hash}；未消费消息/索引队列。`);
      const result = await app.rpc.request("model/list", {});
      console.log(redact(`Codex、动态工具、Skill 与记忆配置核验通过；模型目录：${result.data.map(item => item.model).join(", ")}`));
    } finally { await app.close(); }
  } else {
    const agent = new AgentDefinition(config.root, config.agentFile);
    const workspaceDir = await resolveWorkspace(config.root, agent.workspacePath);
    const files = createFileTools(config.root, { workspaceDir, sources: agent.sources, outputs: agent.outputs, assertCurrent: () => agent.assertCurrent() });
    const tools = await createToolService(config.root, { files, agent, nodeEnv: config.launch.env.NODE_ENV || "development" });
    console.log(`Agent：${agent.definition.agent.id}；工作区：${workspaceDir}\n允许工具：${tools.specs.map(tool => tool.name).join("、")}\n静态配置检查通过；尚未连接 PostgreSQL、Redis 或 Codex。`);
    for (const warning of agent.warnings) console.log(warning);
  }
  console.log("没有发送模型生成请求；这不代表 API Key 已通过验证。");
} catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
