import { gatewayEndpoint } from "../gateway/index.mjs";
import { createModelRouter } from "../gateway/router.mjs";

function booleanValue(environment, name, fallback) {
  const value = environment[name]?.trim() || String(fallback);
  if (!["true", "false"].includes(value)) throw new Error(`${name} 必须为 true 或 false。`);
  return value === "true";
}

// 模型参数来自部署配置，角色由调用方显式传入；不按厂商名分支。
// 模型能力：模型清单（config/models.json）里有 CODEX_MODEL 就以清单为准，否则读 .env 里的 CODEX_MODEL_*；
// 工具输出上限、上下文可用比例等属于本脚手架的设置，始终读 .env。最终转换成 Codex 0.154.0 的目录格式。
export function buildModelCatalog(environment, instructions = "", registry = null, models = []) {
  const text = (name, fallback = "") => environment[name]?.trim() || fallback;
  const required = name => {
    const value = text(name);
    if (!value) throw new Error(`生成模型目录缺少 ${name}；请检查 .env。`);
    return value;
  };
  const boolean = (name, fallback = "false") => booleanValue(environment, name, fallback);
  const integer = (name, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = text(name, fallback === undefined ? "" : String(fallback));
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
      throw new Error(`${name} 必须是 1 到 ${maximum} 之间的整数。`);
    }
    return Number(value);
  };
  const choice = (name, allowed, fallback = "") => {
    const value = text(name, fallback);
    if (!allowed.includes(value)) throw new Error(`${name} 不在支持的选项中：${allowed.join("、")}。`);
    return value;
  };
  const list = (name, allowed, fallback = "") => {
    const value = text(name, fallback);
    if (!value) return [];
    const items = value.split(",").map(item => item.trim());
    if (items.some(item => !allowed.includes(item)) || new Set(items).size !== items.length) {
      throw new Error(`${name} 必须是逗号分隔、不重复的选项：${allowed.join("、")}。`);
    }
    return items;
  };

  if (text("CODEX_MODEL_CATALOG_JSON")) {
    throw new Error("CODEX_MODEL_CATALOG_JSON 已停用，请移除旧路径，改用 .env 中的模型目录参数。");
  }
  if (!boolean("CODEX_MODEL_CATALOG_ENABLED")) return null;
  const model = required("CODEX_MODEL");
  const specOf = slug => {
    const listed = registry?.models?.[slug];
    const spec = listed ? {
      displayName: listed.displayName || slug, description: listed.description || null,
      contextWindow: listed.contextWindow, maxContextWindow: listed.maxContextWindow || listed.contextWindow,
      modalities: listed.inputModalities || ["text"], reasoningLevels: listed.reasoningLevels || [],
      defaultReasoning: listed.defaultReasoningLevel || null, reasoningSummary: listed.reasoningSummary || "none",
      originalImages: Boolean(listed.supportsImageDetailOriginal),
      supportVerbosity: Boolean(listed.supportVerbosity), verbosity: listed.defaultVerbosity || "",
    } : {
      displayName: text("CODEX_MODEL_DISPLAY_NAME", slug), description: text("CODEX_MODEL_DESCRIPTION") || null,
      contextWindow: integer("CODEX_MODEL_CONTEXT_WINDOW"), maxContextWindow: null,
      modalities: list("CODEX_MODEL_INPUT_MODALITIES", ["text", "image", "audio"], "text"),
      reasoningLevels: list("CODEX_MODEL_REASONING_LEVELS", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
      defaultReasoning: text("CODEX_MODEL_DEFAULT_REASONING_LEVEL") || null,
      reasoningSummary: choice("CODEX_MODEL_REASONING_SUMMARY", ["none", "auto", "concise", "detailed"], "none"),
      originalImages: boolean("CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL"),
      supportVerbosity: boolean("CODEX_MODEL_SUPPORT_VERBOSITY"), verbosity: choice("CODEX_MODEL_DEFAULT_VERBOSITY", ["", "low", "medium", "high"]),
    };
    if (!listed) spec.maxContextWindow = integer("CODEX_MODEL_MAX_CONTEXT_WINDOW", spec.contextWindow);
    if (spec.maxContextWindow < spec.contextWindow) throw new Error("CODEX_MODEL_MAX_CONTEXT_WINDOW 不能小于 CODEX_MODEL_CONTEXT_WINDOW。");
    if (spec.defaultReasoning && !spec.reasoningLevels.includes(spec.defaultReasoning)) {
      throw new Error("CODEX_MODEL_DEFAULT_REASONING_LEVEL 必须包含在 CODEX_MODEL_REASONING_LEVELS 中。");
    }
    if (spec.originalImages && !spec.modalities.includes("image")) {
      throw new Error("启用 CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL 时，INPUT_MODALITIES 必须包含 image。");
    }
    if (spec.verbosity && !spec.supportVerbosity) throw new Error("设置 DEFAULT_VERBOSITY 时，CODEX_MODEL_SUPPORT_VERBOSITY 必须为 true。");
    return spec;
  };
  // 网关模式下目录里放所有可用的对话模型（默认的排第一）：按轮切换模型时 Codex 才有正确的能力信息。
  // 其他模型只能取自清单；直连时目录里只有 CODEX_MODEL 一个。
  const slugs = [model, ...models.filter(id => id !== model && registry?.models?.[id])];
  const specs = slugs.map(specOf);
  const patchType = choice("CODEX_MODEL_APPLY_PATCH_TOOL_TYPE", ["none", "freeform"], "none");
  const shellType = choice("CODEX_MODEL_SHELL_TYPE", ["disabled", "unified_exec"], "disabled");
  const toolOutputLimit = integer("CODEX_MODEL_TOOL_OUTPUT_LIMIT", 10000);
  const effectivePercent = integer("CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_PERCENT", 95, 100);

  // 白名单映射：绝不把整个 environment 写进模型目录。
  return {
    models: slugs.map((slug, index) => {
      const spec = specs[index];
      return {
        slug,
        display_name: spec.displayName,
        description: spec.description,
        default_reasoning_level: spec.defaultReasoning,
        supported_reasoning_levels: spec.reasoningLevels.map(effort => ({ effort, description: `${effort} reasoning effort` })),
        shell_type: shellType,
        visibility: "list",
        supported_in_api: true,
        priority: index + 1,
        support_verbosity: spec.supportVerbosity,
        default_verbosity: spec.verbosity || null,
        default_reasoning_summary: spec.reasoningSummary,
        apply_patch_tool_type: patchType === "none" ? null : patchType,
        truncation_policy: { mode: "tokens", limit: toolOutputLimit },
        context_window: spec.contextWindow,
        max_context_window: spec.maxContextWindow,
        effective_context_window_percent: effectivePercent,
        input_modalities: spec.modalities,
        supports_image_detail_original: spec.originalImages,
        experimental_supported_tools: [],
        model_messages: { instructions_template: instructions }
      };
    })
  };
}

export function buildRestrictedLaunch(environment, options = {}) {
  const launch = buildAppServerLaunch({ ...environment,
    CODEX_MODEL_SHELL_TYPE: "disabled", CODEX_MODEL_APPLY_PATCH_TOOL_TYPE: "none" }, "", options);
  // goals：线程目标会让 Codex 绕过任务队列自动连续发起轮次；project_doc_max_bytes=0：workspace
  // 及其上级目录的 AGENTS.md 是用户数据，不能进入模型指令（角色指令走 instructions_template）。
  launch.args.push("-c", "features.goals=false", "-c", "project_doc_max_bytes=0",
    "-c", "features.shell_tool=false", "-c", "features.apply_patch_freeform=false",
    "-c", "agents.enabled=false", "-c", "features.view_image=false", "-c", "features.image_generation=false", "-c", "features.multi_agent=false", "-c", "features.apps=false", "-c", "features.hooks=false", "-c", "features.plugins=false");
  return launch;
}

export function buildAppServerLaunch(environment, instructions = "", { registry = null } = {}) {
  const args = ["app-server", "--listen", "stdio://"];
  // 网关模式：Codex 的接口地址和密钥换成本机网关的，后面按直连同样校验。
  const gateway = gatewayEndpoint(environment);
  // 网关模式下由模型路由决定默认的对话模型（CODEX_MODEL 可覆盖），工作流步骤再按需切换（见 messages）。
  const router = gateway && registry ? createModelRouter(registry, environment) : null;
  if (gateway) environment = { ...environment, CODEX_BASE_URL: gateway.baseUrl, CODEX_API_KEY: gateway.apiKey, ...(router ? { CODEX_MODEL: router.resolve().id } : {}) };
  const env = { ...environment };
  // 各家模型的密钥只给网关，Codex 只拿访问模型接口要用的 CODEX_API_KEY。
  for (const key of Object.keys(env)) {
    if (/^(DATABASE_URL|REDIS_URL|AGENT_DB_PASSWORD|REDIS_PASSWORD|AGENT_GATEWAY_KEY|PG[A-Z_]+)$/.test(key) || (/_API_KEY$/.test(key) && key !== "CODEX_API_KEY")) delete env[key];
  }
  const model = environment.CODEX_MODEL?.trim() || undefined;
  if (model && /[\u0000-\u001f\u007f]/.test(model)) throw new Error("CODEX_MODEL 不能包含控制字符。");
  const timeoutMs = Number(environment.DEMO_TIMEOUT_MS || 180_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("DEMO_TIMEOUT_MS 必须是 1 到 2147483647 之间的整数。");
  }
  const catalog = buildModelCatalog(environment, instructions, registry, router ? router.chatModels() : []);
  // 本示例不依赖服务商的内置联网搜索能力。
  args.push("-c", 'web_search="disabled"');

  const useApiKey = environment.CODEX_API_KEY !== undefined || environment.CODEX_BASE_URL !== undefined;
  if (!useApiKey) return { args, env, model, catalog, timeoutMs, authMode: "existing" };

  const values = Object.fromEntries(
    ["CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL"].map(name => [name, environment[name]?.trim() || ""])
  );
  const missing = Object.keys(values).filter(name => !values[name]);
  if (missing.length) throw new Error(`API Key 模式缺少 ${missing.join("、")}；请检查本项目 .env。`);
  if (Object.values(values).some(value => /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("API 配置不能包含换行或控制字符。");
  }
  let endpoint;
  try { endpoint = new URL(values.CODEX_BASE_URL); }
  catch { throw new Error("CODEX_BASE_URL 必须是完整的 API 基础地址。"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("CODEX_BASE_URL 必须使用 HTTPS；只有本机回环地址允许 HTTP。");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("CODEX_BASE_URL 不能包含用户名、密码、查询参数或片段。");
  }
  if (/\/(responses|chat\/completions)\/?$/.test(endpoint.pathname)) {
    throw new Error("CODEX_BASE_URL 应为基础地址，不要添加 /responses 或 /chat/completions。");
  }
  // provider ID 是本程序固定的配置名称，不代表任何特定模型厂商。
  args.push(
    "-c", 'model_provider="project_api"',
    "-c", `model=${JSON.stringify(values.CODEX_MODEL)}`,
    "-c", 'model_providers.project_api.name="Project API"',
    "-c", `model_providers.project_api.base_url=${JSON.stringify(values.CODEX_BASE_URL)}`,
    "-c", 'model_providers.project_api.env_key="CODEX_API_KEY"',
    "-c", 'model_providers.project_api.wire_api="responses"',
    "-c", 'model_providers.project_api.requires_openai_auth=false'
  );
  // 密钥只通过子进程环境传递，不进入启动参数。
  env.CODEX_API_KEY = values.CODEX_API_KEY;
  return { args, env, model, catalog, timeoutMs, baseUrl: values.CODEX_BASE_URL, authMode: "apiKey", gateway: Boolean(gateway), router };
}
