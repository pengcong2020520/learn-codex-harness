// 模型网关（Bifrost）：Codex 和我们的工具只连本机网关，各家模型的密钥只交给网关。
// 这里读模型清单（config/models.json）、推导连接参数、生成网关配置；按用途和场景挑模型见 router.mjs。
import fs from "node:fs";
import path from "node:path";
import { limitValue } from "../usage/config.mjs";

export const GATEWAY_DEFAULT_PORT = 4330;
// 用途：对话由 Codex 使用，其余由工具层（如知识检索、生图）经网关调用。看图、长上下文是对话模型的能力，不单列用途。
export const PURPOSES = Object.freeze(["chat", "embedding", "rerank", "image", "video", "tts", "asr"]);
const KEY_ENV = /^[A-Z][A-Z0-9_]*_API_KEY$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SCENE = /^[a-z][a-z0-9-]{0,31}$/;
const REASONING = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const MODALITIES = ["text", "image", "audio"];

export function splitModelId(id) {
  const index = id.indexOf("/");
  return { provider: id.slice(0, index), model: id.slice(index + 1) };
}

// 容器名（如 http://ollama:11434）或本机地址属于内网，允许 http；网关访问它们要显式放行内网地址。
const internalHost = url => !url.hostname.includes(".") || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

function checkBaseUrl(value, label, fail) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} 不是完整地址。`); }
  if (url.search || url.hash || url.username || url.password) fail(`${label} 不能带查询参数或账号。`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && internalHost(url))) fail(`${label} 必须是 https；只有容器名或本机地址可以用 http。`);
  return url;
}

export function validateRegistry(registry) {
  const fail = message => { throw new Error(`config/models.json：${message}`); };
  if (registry?.schemaVersion !== 1) fail("schemaVersion 必须是 1。");
  if (registry.currency !== undefined && !["CNY", "USD"].includes(registry.currency)) fail("currency 必须是 CNY 或 USD。默认是 CNY。");
  const providers = registry.providers || {}, models = registry.models || {};
  const envNames = new Set();
  for (const [id, provider] of Object.entries(providers)) {
    if (!NAME.test(id)) fail(`服务商名 ${id} 只能用小写字母、数字、- 和 _。`);
    if (provider.type === "byteplus" && id !== "byteplus") fail("byteplus 是内置服务商，名称必须是 byteplus。");
    if (!NAME.test(provider.type || "")) fail(`服务商 ${id} 缺少 type（网关里的接口类型，如 openai、anthropic）。`);
    // 启用条件：keyEnv（密钥）和 baseUrlEnv（地址，如本地部署的 Ollama）里声明的变量都有值。至少要有一项。
    if (!provider.keyEnv && !provider.baseUrlEnv) fail(`服务商 ${id} 至少要有 keyEnv 或 baseUrlEnv。`);
    if (provider.keyEnv !== undefined && (!KEY_ENV.test(provider.keyEnv) || provider.keyEnv === "CODEX_API_KEY")) fail(`服务商 ${id} 的 keyEnv 必须形如 XXX_API_KEY，且不能是 CODEX_API_KEY。`);
    if (provider.baseUrlEnv !== undefined && (!ENV_NAME.test(provider.baseUrlEnv) || provider.baseUrlEnv.endsWith("_API_KEY"))) fail(`服务商 ${id} 的 baseUrlEnv 必须是大写变量名，且不能以 _API_KEY 结尾。`);
    if (provider.baseUrl !== undefined && provider.baseUrlEnv !== undefined) fail(`服务商 ${id} 的 baseUrl 和 baseUrlEnv 只能写一个。`);
    for (const name of [provider.keyEnv, provider.baseUrlEnv].filter(Boolean)) {
      if (envNames.has(name)) fail(`环境变量 ${name} 被多个服务商使用。`);
      envNames.add(name);
    }
    if (provider.baseUrl !== undefined) checkBaseUrl(provider.baseUrl, `服务商 ${id} 的 baseUrl`, fail);
  }
  for (const [id, spec] of Object.entries(models)) {
    const { provider, model } = splitModelId(id);
    if (!providers[provider] || !model) fail(`模型 ${id} 必须写成“服务商/模型名”，且服务商已在 providers 中登记。`);
    if (spec.pricing !== undefined) {
      if (!spec.pricing || typeof spec.pricing !== "object" || Array.isArray(spec.pricing)) fail(`模型 ${id} 的 pricing 必须是价格对象。`);
      const mediaOnly = Array.isArray(spec.purposes) && spec.purposes.every(purpose => ["image", "video"].includes(purpose));
      if (!Object.keys(spec.pricing).length) fail(`模型 ${id} 的 pricing 不能为空。`);
      for (const field of ["input", "cachedInput", "output", "perImage", "perVideoSecond"]) {
        const value = spec.pricing[field];
        if (value === undefined && (mediaOnly || ["cachedInput", "perImage", "perVideoSecond"].includes(field))) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`模型 ${id} 的 pricing.${field} 必须是非负数字，token 按每百万、perImage 按张、perVideoSecond 按秒计价。`);
      }
    }
    const purposes = spec.purposes;
    if (!Array.isArray(purposes) || !purposes.length || purposes.some(item => !PURPOSES.includes(item)) || new Set(purposes).size !== purposes.length) {
      fail(`模型 ${id} 的 purposes 必须是不重复的用途：${PURPOSES.join("、")}。`);
    }
    if (spec.nativeTools !== undefined) {
      if (!purposes.includes("chat")) fail(`模型 ${id} 的 nativeTools 只能用于 purposes 含 chat 的模型。`);
      if (!Array.isArray(spec.nativeTools) || spec.nativeTools.some(tool => tool !== "web_search") || new Set(spec.nativeTools).size !== spec.nativeTools.length) {
        fail(`模型 ${id} 的 nativeTools 必须是不重复的字符串数组，目前只允许 web_search。`);
      }
    }
    const positive = (name, required) => {
      if (spec[name] === undefined ? required : !Number.isSafeInteger(spec[name]) || spec[name] < 1) fail(`模型 ${id} 的 ${name} 必须是正整数。`);
    };
    positive("contextWindow", purposes.includes("chat"));
    positive("maxOutputTokens", false);
    // 向量的维数决定向量库的结构，换模型时维数不同就要重建索引，所以必须写明。
    positive("dimensions", purposes.includes("embedding"));
    if ((spec.inputModalities || ["text"]).some(item => !MODALITIES.includes(item))) fail(`模型 ${id} 的 inputModalities 只能是 ${MODALITIES.join("、")}。`);
    const levels = spec.reasoningLevels || [];
    if (levels.some(level => !REASONING.includes(level))) fail(`模型 ${id} 的 reasoningLevels 只能是 ${REASONING.join("、")}。`);
    if (spec.defaultReasoningLevel && !levels.includes(spec.defaultReasoningLevel)) fail(`模型 ${id} 的 defaultReasoningLevel 必须在 reasoningLevels 里。`);
    if (spec.defaultVerbosity && !spec.supportVerbosity) fail(`模型 ${id} 设置 defaultVerbosity 时 supportVerbosity 必须为 true。`);
    // Claude 格式的接口必须带输出上限；Codex 不发，网关就按清单填，清单里没有会被网关默认的 4096 截断长输出。
    if (providers[provider].type === "anthropic" && purposes.includes("chat") && !spec.maxOutputTokens) fail(`模型 ${id} 走 Claude 格式接口，必须填 maxOutputTokens。`);
    for (const target of spec.fallbacks || []) {
      if (target === id || !models[target]) fail(`模型 ${id} 的备用模型 ${target} 必须是清单里的其他模型。`);
      if (!purposes.every(purpose => models[target].purposes?.includes(purpose))) fail(`模型 ${id} 的备用模型 ${target} 要能做它的全部用途。`);
    }
  }
  // 路由表：每种用途按优先顺序列出候选，第一个能用的（服务商已启用）就是默认。
  for (const [purpose, candidates] of Object.entries(registry.routes || {})) {
    if (!PURPOSES.includes(purpose)) fail(`routes 里的 ${purpose} 不是已知用途。`);
    if (!Array.isArray(candidates) || !candidates.length) fail(`routes.${purpose} 必须是非空的模型列表。`);
    for (const id of candidates) if (!models[id]?.purposes.includes(purpose)) fail(`routes.${purpose} 里的 ${id} 必须是清单里用途包含 ${purpose} 的模型。`);
  }
  // 场景可混合用途，解析时先按本次用途过滤候选。
  for (const [scene, candidates] of Object.entries(registry.scenes || {})) {
    if (!SCENE.test(scene)) fail(`场景名 ${scene} 只能用小写字母、数字和 -，以字母开头。`);
    if (!Array.isArray(candidates) || !candidates.length) fail(`scenes.${scene} 必须是非空的模型列表。`);
    for (const id of candidates) if (!models[id]) fail(`scenes.${scene} 里的 ${id} 必须是清单里的模型。`);
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
  // 放进容器时网关不在本机回环上，用 AGENT_GATEWAY_URL 指到容器名（如 http://gateway:8080/v1）。
  const override = environment.AGENT_GATEWAY_URL?.trim();
  if (override) checkBaseUrl(override, "AGENT_GATEWAY_URL", message => { throw new Error(message); });
  return { baseUrl: override || `http://127.0.0.1:${port}/v1`, apiKey: key, port };
}

// 模型接口的地址和密钥：网关模式取网关，直连模式取 CODEX_BASE_URL / CODEX_API_KEY。
export function modelEndpoint(environment) {
  const gateway = gatewayEndpoint(environment);
  return gateway ? { baseUrl: gateway.baseUrl, apiKey: gateway.apiKey } : { baseUrl: environment.CODEX_BASE_URL, apiKey: environment.CODEX_API_KEY };
}

// keyEnv、baseUrlEnv 里声明的变量都有值，这家服务商才启用；没启用的服务商和它的模型都不进网关配置。
export function enabledProviders(registry, environment) {
  // 部署时只传非敏感的服务商清单，agent 不持有服务商密钥。
  if (environment.AGENT_ENABLED_PROVIDERS !== undefined) {
    const ids = environment.AGENT_ENABLED_PROVIDERS.split(",").filter(Boolean);
    if (ids.some(id => !registry.providers[id])) throw new Error("启用清单包含未知服务商。");
    return new Set(ids);
  }
  return new Set(Object.entries(registry.providers)
    .filter(([, provider]) => [provider.keyEnv, provider.baseUrlEnv].filter(Boolean).every(name => environment[name]?.trim()))
    .map(([id]) => id));
}

const baseUrlOf = (provider, environment) => provider.baseUrl || (provider.baseUrlEnv ? environment[provider.baseUrlEnv].trim() : null);

// 网关的模型参数表：只放已启用服务商的模型，键是“服务商/模型名”（网关按这个匹配）。
// 用本地文件代替网关从官网下载的公开大表：清单里的输出上限才会生效，也少一次对外下载。
export function buildModelParameters(registry, environment) {
  const enabled = enabledProviders(registry, environment);
  const mode = spec => spec.purposes.includes("chat") ? "chat" : spec.purposes.includes("embedding") ? "embedding" : spec.purposes[0];
  return Object.fromEntries(Object.entries(registry.models).filter(([id]) => enabled.has(splitModelId(id).provider)).map(([id, spec]) => [id, {
    provider: splitModelId(id).provider, mode: mode(spec), ...(spec.contextWindow ? { max_input_tokens: spec.contextWindow } : {}),
    ...(spec.maxOutputTokens ? { max_output_tokens: spec.maxOutputTokens, max_tokens: spec.maxOutputTokens } : {}),
  }]));
}

export function buildGatewayConfig(registry, environment) {
  const daily = limitValue(environment, "AGENT_BUDGET_DAILY_TOKENS", true);
  const gatewayLimit = limitValue(environment, "AGENT_GATEWAY_DAILY_TOKENS", true) ?? (daily === null ? null : Math.ceil(daily * 1.5));
  if (gatewayLimit !== null && !Number.isSafeInteger(gatewayLimit)) throw new Error("网关每日 token 上限超出安全整数范围，请用 AGENT_GATEWAY_DAILY_TOKENS 指定。");
  const enabled = enabledProviders(registry, environment);
  if (!enabled.size) throw new Error("没有启用任何模型服务商：在 .env 里至少填一家的密钥（如 KIMI_API_KEY），见 docs/model-gateway.md。");
  const providers = {};
  for (const id of enabled) {
    const provider = registry.providers[id];
    const models = Object.keys(registry.models).filter(model => splitModelId(model).provider === id).map(model => splitModelId(model).model);
    const baseUrl = baseUrlOf(provider, environment);
    if (baseUrl && provider.baseUrlEnv) checkBaseUrl(baseUrl, `${provider.baseUrlEnv}`, message => { throw new Error(message); });
    providers[id] = {
      // 不需要密钥的服务（如本地 Ollama）也要登记一把空密钥，网关靠它知道这家有哪些模型；
      // Ollama 的地址还要写在密钥条目里（ollama_key_config.url），否则网关认为没有能用的密钥。
      keys: [{ name: id, value: provider.keyEnv ? `env.${provider.keyEnv}` : "", models, weight: 1,
        ...(provider.type === "ollama" && baseUrl ? { ollama_key_config: { url: baseUrl } } : {}) }],
      ...(baseUrl ? { network_config: { base_url: baseUrl, ...(internalHost(new URL(baseUrl)) ? { allow_private_network: true } : {}) } } : {}),
      // 名字和接口类型不同（如 kimi 走 openai 接口）就是自定义服务商。
      ...(id !== provider.type ? { custom_provider_config: { base_provider_type: provider.type, ...(provider.keyEnv ? {} : { is_key_less: true }) } } : {}),
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
    // 不在后台同步 Bifrost 的 MCP 目录（用不到，也少一个对外连接）；模型参数表用本地文件（见 buildModelParameters）。
    framework: { pricing: { mcp_library_sync_interval: 0, model_parameters_url: "file:///app/data/model-parameters.json" } },
    providers,
    governance: {
      // Codex 和工具用 AGENT_GATEWAY_KEY 访问网关；没有这把钥匙的请求一律 401。
      virtual_keys: [{ id: "codex-harness", name: "codex-harness", value: "env.AGENT_GATEWAY_KEY", is_active: true, allow_all_providers: true,
        ...(gatewayLimit === null ? {} : { rate_limit_id: "codex-harness-daily" }) }],
      ...(gatewayLimit === null ? {} : { rate_limits: [{ id: "codex-harness-daily", token_max_limit: gatewayLimit, token_reset_duration: "1d", calendar_aligned: true }] }),
      routing_rules: routingRules,
    },
  };
}

// 只检查会进入网关的备用链；能力损失提醒不阻止启动。
export function fallbackWarnings(registry, environment) {
  const enabled = enabledProviders(registry, environment), warnings = [];
  for (const [id, spec] of Object.entries(registry.models)) {
    if (!spec.purposes.includes("chat") || !enabled.has(splitModelId(id).provider)) continue;
    for (const fallback of spec.fallbacks || []) {
      if (!enabled.has(splitModelId(fallback).provider)) continue;
      const target = registry.models[fallback];
      for (const tool of spec.nativeTools || []) if (!target.nativeTools?.includes(tool)) {
        const label = tool === "web_search" ? "联网搜索" : tool;
        warnings.push(`${id} 的备用 ${fallback} 不支持${label}：切到备用时那一轮没有${tool === "web_search" ? "搜索" : label}`);
      }
      if (spec.inputModalities?.includes("image") && !target.inputModalities?.includes("image"))
        warnings.push(`${id} 的备用 ${fallback} 不能看图：切到备用时那一轮无法处理图片`);
    }
  }
  return warnings;
}
