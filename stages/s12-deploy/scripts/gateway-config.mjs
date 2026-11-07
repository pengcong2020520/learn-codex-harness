// 生成模型网关（Bifrost）的配置：读 config/models.json 和 .env，写 .data/gateway/config.json 与 model-parameters.json。
// 配置里只有环境变量引用（如 env.KIMI_API_KEY），不含密钥本身；密钥由 compose 在启动容器时传入。
// npm run gateway:config        生成并显示启用了哪些服务商、默认模型和备用链
// npm run gateway:key           .env 里还没有 AGENT_GATEWAY_KEY 时生成一把写进去（不在终端显示）
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../server/modules/config/index.mjs";
import { buildGatewayConfig, buildModelParameters, gatewayEndpoint, loadModelRegistry } from "../server/modules/gateway/index.mjs";
import { createModelRouter } from "../server/modules/gateway/router.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function writeGatewayConfig(projectRoot = root, inherited = process.env) {
  const environment = loadEnvironment(projectRoot, inherited);
  if (!gatewayEndpoint(environment)) throw new Error("没有启用模型网关：在 .env 里设置 AGENT_GATEWAY_KEY（npm run gateway:key 可以生成），见 docs/model-gateway.md。");
  const registry = loadModelRegistry(projectRoot);
  if (!registry) throw new Error("缺少 config/models.json。");
  const config = buildGatewayConfig(registry, environment);
  // 先确认能选出默认的对话模型（服务启动时也要用）；其他用途选不出来不影响网关，只在摘要里说明。
  const router = createModelRouter(registry, environment);
  const routes = { chat: router.resolve().id };
  for (const purpose of Object.keys(registry.routes || {}).filter(purpose => purpose !== "chat")) {
    try { routes[purpose] = router.resolve({ purpose }).id; } catch (error) { if (error.code !== "MODEL_UNAVAILABLE") throw error; routes[purpose] = null; }
  }
  const file = path.join(projectRoot, ".data/gateway/config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 容器里的网关进程（非 root）要能读；两个文件里都没有密钥。
  for (const [name, content] of [["config.json", config], ["model-parameters.json", buildModelParameters(registry, environment)]]) {
    const target = path.join(path.dirname(file), name);
    fs.writeFileSync(target, JSON.stringify(content, null, 2) + "\n", { mode: 0o644 });
    fs.chmodSync(target, 0o644);
  }
  fs.writeFileSync(path.join(path.dirname(file), "enabled-providers.json"), JSON.stringify(Object.keys(config.providers)) + "\n", { mode: 0o644 });
  return { file, config, routes, model: routes.chat };
}

// 已有值就不动；有空的 AGENT_GATEWAY_KEY= 行就填进去，否则追加。文件不存在时新建并只允许本人读写。
export function ensureGatewayKey(projectRoot = root) {
  const file = path.join(projectRoot, ".env");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^AGENT_GATEWAY_KEY=["']?[^"'\s]/m.test(text)) return false;
  const line = `AGENT_GATEWAY_KEY=sk-bf-${randomBytes(24).toString("hex")}`;
  const empty = /^AGENT_GATEWAY_KEY=["']{0,2}[ \t]*$/m;
  const next = empty.test(text) ? text.replace(empty, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  fs.writeFileSync(file, next, { mode: 0o600 });
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--ensure-key")) {
      console.log(ensureGatewayKey() ? "已在 .env 写入新的 AGENT_GATEWAY_KEY。" : ".env 里已有 AGENT_GATEWAY_KEY，未改动。");
      process.exit(0);
    }
    const { file, config, routes } = writeGatewayConfig();
    const labels = { chat: "对话", embedding: "向量", rerank: "重排序", image: "生图", video: "生视频", tts: "语音合成", asr: "语音识别" };
    console.log(`已生成 ${path.relative(root, file)}`);
    console.log(`启用的服务商：${Object.keys(config.providers).join("、")}`);
    for (const [purpose, id] of Object.entries(routes)) console.log(`${labels[purpose]}：${id || "没有可用模型（见 config/models.json 的 routes）"}`);
    for (const rule of config.governance.routing_rules) console.log(`备用：${rule.name}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
