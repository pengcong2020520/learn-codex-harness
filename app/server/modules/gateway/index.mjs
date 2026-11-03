// 模型网关（Bifrost）：Codex 只连本机网关，各家模型的密钥只交给网关。
// 这里读模型清单（config/models.json）、推导 Codex 的连接参数、生成网关配置。
import fs from "node:fs";
import path from "node:path";

export const GATEWAY_DEFAULT_PORT = 4330;
const KEY_ENV = /^[A-Z][A-Z0-9_]*_API_KEY$/;
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const REASONING = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const MODALITIES = ["text", "image", "audio"];

export function splitModelId(id) {
  const index = id.indexOf("/");
  return { provider: id.slice(0, index), model: id.slice(index + 1) };
}

export function validateRegistry(registry) {
  const fail = message => { throw new Error(`config/models.json：${message}`); };
  if (registry?.schemaVersion !== 1) fail("schemaVersion 必须是 1。");
  const providers = registry.providers || {}, models = registry.models || {};
  const keyEnvs = new Set();
  for (const [id, provider] of Object.entries(providers)) {
    if (!NAME.test(id)) fail(`服务商名 ${id} 只能用小写字母、数字、- 和 _。`);
    if (!NAME.test(provider.type || "")) fail(`服务商 ${id} 缺少 type（网关里的接口类型，如 openai、anthropic）。`);
    if (!KEY_ENV.test(provider.keyEnv || "") || provider.keyEnv === "CODEX_API_KEY") fail(`服务商 ${id} 的 keyEnv 必须形如 XXX_API_KEY，且不能是 CODEX_API_KEY。`);
    if (keyEnvs.has(provider.keyEnv)) fail(`keyEnv ${provider.keyEnv} 重复。`);
    keyEnvs.add(provider.keyEnv);
    if (provider.baseUrl !== undefined) {
      let url;
      try { url = new URL(provider.baseUrl); } catch { fail(`服务商 ${id} 的 baseUrl 不是完整地址。`); }
      if (url.protocol !== "https:" || url.search || url.hash || url.username) fail(`服务商 ${id} 的 baseUrl 必须是 https，且不带查询参数或账号。`);
    }
  }
  for (const [id, spec] of Object.entries(models)) {
    const { provider, model } = splitModelId(id);
    if (!providers[provider] || !model) fail(`模型 ${id} 必须写成“服务商/模型名”，且服务商已在 providers 中登记。`);
    if (!Number.isSafeInteger(spec.contextWindow) || spec.contextWindow < 1) fail(`模型 ${id} 的 contextWindow 必须是正整数。`);
    if ((spec.inputModalities || ["text"]).some(item => !MODALITIES.includes(item))) fail(`模型 ${id} 的 inputModalities 只能是 ${MODALITIES.join("、")}。`);
    const levels = spec.reasoningLevels || [];
    if (levels.some(level => !REASONING.includes(level))) fail(`模型 ${id} 的 reasoningLevels 只能是 ${REASONING.join("、")}。`);
    if (spec.defaultReasoningLevel && !levels.includes(spec.defaultReasoningLevel)) fail(`模型 ${id} 的 defaultReasoningLevel 必须在 reasoningLevels 里。`);
    if (spec.defaultVerbosity && !spec.supportVerbosity) fail(`模型 ${id} 设置 defaultVerbosity 时 supportVerbosity 必须为 true。`);
    for (const target of spec.fallbacks || []) {
      if (target === id || !models[target]) fail(`模型 ${id} 的备用模型 ${target} 必须是清单里的其他模型。`);
    }
  }
  return registry;
}

export function loadModelRegistry(root) {
  const file = path.join(root, "config/models.json");
  if (!fs.existsSync(file)) return null;
  let registry;
  try { registry = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("config/models.json 不是合法的 JSON。"); }
  return validateRegistry(registry);
}

// 网关模式：设置了 AGENT_GATEWAY_KEY。Codex 的接口地址和密钥都指向本机网关，不再直连各家。
export function gatewayEndpoint(environment) {
  const key = environment.AGENT_GATEWAY_KEY?.trim();
  if (!key) return null;
  if (environment.CODEX_BASE_URL?.trim() || environment.CODEX_API_KEY?.trim()) {
    throw new Error("启用模型网关（AGENT_GATEWAY_KEY）时不要再设置 CODEX_BASE_URL、CODEX_API_KEY：Codex 只连本机网关。");
  }
  if (/[\u0000-\u001f\u007f\s]/.test(key)) throw new Error("AGENT_GATEWAY_KEY 不能包含空白或控制字符。");
  // Bifrost 只把 sk-bf- 开头的值当作网关访问密钥，其他值会被当成某家模型的密钥而拒绝。
  if (!key.startsWith("sk-bf-")) throw new Error("AGENT_GATEWAY_KEY 必须以 sk-bf- 开头；运行 npm run gateway:key 重新生成。");
  const port = Number(environment.AGENT_GATEWAY_PORT?.trim() || GATEWAY_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_GATEWAY_PORT 必须是 1 到 65535 的整数。");
  return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, port };
}

// 模型接口的地址和密钥：网关模式取网关，直连模式取 CODEX_BASE_URL / CODEX_API_KEY。
export function modelEndpoint(environment) {
  const gateway = gatewayEndpoint(environment);
  return gateway ? { baseUrl: gateway.baseUrl, apiKey: gateway.apiKey } : { baseUrl: environment.CODEX_BASE_URL, apiKey: environment.CODEX_API_KEY };
}

// 已填密钥的服务商才启用；没填的服务商和它的模型都不进网关配置。
export function enabledProviders(registry, environment) {
  return new Set(Object.entries(registry.providers).filter(([, provider]) => environment[provider.keyEnv]?.trim()).map(([id]) => id));
}

export function buildGatewayConfig(registry, environment) {
  const selected = environment.CODEX_MODEL?.trim();
  if (!selected || !registry.models[selected]) throw new Error(`CODEX_MODEL（${selected || "未设置"}）不在 config/models.json 里；网关模式要写成“服务商/模型名”，如 kimi/kimi-k2.7-code。`);
  const enabled = enabledProviders(registry, environment);
  const { provider: selectedProvider } = splitModelId(selected);
  if (!enabled.has(selectedProvider)) throw new Error(`默认模型 ${selected} 的服务商没有密钥：在 .env 里填 ${registry.providers[selectedProvider].keyEnv}。`);

  const providers = {};
  for (const id of enabled) {
    const provider = registry.providers[id];
    const models = Object.keys(registry.models).filter(model => splitModelId(model).provider === id).map(model => splitModelId(model).model);
    providers[id] = {
      keys: [{ name: id, value: `env.${provider.keyEnv}`, models, weight: 1 }],
      ...(provider.baseUrl ? { network_config: { base_url: provider.baseUrl } } : {}),
      // 名字和接口类型不同（如 kimi 走 openai 接口）就是自定义服务商。
      ...(id !== provider.type ? { custom_provider_config: { base_provider_type: provider.type } } : {}),
    };
  }
  // 备用链：主模型失败（余额不足、限流、服务端错误、超时）后依次改用；只保留已启用的服务商。
  const routingRules = [];
  for (const [id, spec] of Object.entries(registry.models)) {
    const { provider, model } = splitModelId(id);
    const fallbacks = (spec.fallbacks || []).filter(target => enabled.has(splitModelId(target).provider));
    if (!enabled.has(provider) || !fallbacks.length) continue;
    routingRules.push({ id: `fallback-${id.replace(/[^a-zA-Z0-9-]/g, "-")}`, name: `${id} 不可用时改用 ${fallbacks.join("、")}`, enabled: true,
      cel_expression: `provider == ${JSON.stringify(provider)} && model == ${JSON.stringify(model)}`,
      targets: [{ provider, model, weight: 1 }], fallbacks, scope: "global", priority: routingRules.length + 1 });
  }
  return {
    $schema: "https://www.getbifrost.ai/schema",
    // 每次启动都以这个文件为准；配置库放在容器的临时目录里，重启即清空，不保留网页后台改过的设置。
    source_of_truth: "config.json",
    client: { drop_excess_requests: false, enable_logging: false, disable_content_logging: true },
    config_store: { enabled: true, type: "sqlite", config: { path: "/app/data/config.db" } },
    logs_store: { enabled: false },
    // 不在后台同步 Bifrost 的 MCP 目录（用不到，也少一个对外连接）。
    framework: { pricing: { mcp_library_sync_interval: 0 } },
    providers,
    governance: {
      // Codex 用 AGENT_GATEWAY_KEY 访问网关；没有这把钥匙的请求一律 401。
      virtual_keys: [{ id: "codex-harness", name: "codex-harness", value: "env.AGENT_GATEWAY_KEY", is_active: true, allow_all_providers: true }],
      routing_rules: routingRules,
    },
  };
}
