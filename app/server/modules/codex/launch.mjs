function booleanValue(environment, name, fallback) {
  const value = environment[name]?.trim() || String(fallback);
  if (!["true", "false"].includes(value)) throw new Error(`${name} 必须为 true 或 false。`);
  return value === "true";
}

// 模型参数来自部署配置，角色由调用方显式传入；不按厂商名分支。
// 这些 CODEX_MODEL_* 是本脚手架的配置项，最终转换成 Codex 0.154.0 的目录格式。
export function buildModelCatalog(environment, instructions = "") {
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
  const contextWindow = integer("CODEX_MODEL_CONTEXT_WINDOW");
  const maxContextWindow = integer("CODEX_MODEL_MAX_CONTEXT_WINDOW", contextWindow);
  if (maxContextWindow < contextWindow) throw new Error("CODEX_MODEL_MAX_CONTEXT_WINDOW 不能小于 CODEX_MODEL_CONTEXT_WINDOW。");
  const modalities = list("CODEX_MODEL_INPUT_MODALITIES", ["text", "image", "audio"], "text");
  const reasoningLevels = list("CODEX_MODEL_REASONING_LEVELS", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  const defaultReasoning = text("CODEX_MODEL_DEFAULT_REASONING_LEVEL") || null;
  if (defaultReasoning && !reasoningLevels.includes(defaultReasoning)) {
    throw new Error("CODEX_MODEL_DEFAULT_REASONING_LEVEL 必须包含在 CODEX_MODEL_REASONING_LEVELS 中。");
  }
  const originalImages = boolean("CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL");
  if (originalImages && !modalities.includes("image")) {
    throw new Error("启用 CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL 时，INPUT_MODALITIES 必须包含 image。");
  }
  const verbosity = choice("CODEX_MODEL_DEFAULT_VERBOSITY", ["", "low", "medium", "high"]);
  const supportVerbosity = boolean("CODEX_MODEL_SUPPORT_VERBOSITY");
  if (verbosity && !supportVerbosity) throw new Error("设置 DEFAULT_VERBOSITY 时，CODEX_MODEL_SUPPORT_VERBOSITY 必须为 true。");
  const patchType = choice("CODEX_MODEL_APPLY_PATCH_TOOL_TYPE", ["none", "freeform"], "none");

  // 白名单映射：绝不把整个 environment 写进模型目录。
  return {
    models: [{
      slug: model,
      display_name: text("CODEX_MODEL_DISPLAY_NAME", model),
      description: text("CODEX_MODEL_DESCRIPTION") || null,
      default_reasoning_level: defaultReasoning,
      supported_reasoning_levels: reasoningLevels.map(effort => ({ effort, description: `${effort} reasoning effort` })),
      shell_type: choice("CODEX_MODEL_SHELL_TYPE", ["disabled", "unified_exec"], "disabled"),
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      support_verbosity: supportVerbosity,
      default_verbosity: verbosity || null,
      default_reasoning_summary: choice("CODEX_MODEL_REASONING_SUMMARY", ["none", "auto", "concise", "detailed"], "none"),
      apply_patch_tool_type: patchType === "none" ? null : patchType,
      truncation_policy: { mode: "tokens", limit: integer("CODEX_MODEL_TOOL_OUTPUT_LIMIT", 10000) },
      context_window: contextWindow,
      max_context_window: maxContextWindow,
      effective_context_window_percent: integer("CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_PERCENT", 95, 100),
      input_modalities: modalities,
      supports_image_detail_original: originalImages,
      experimental_supported_tools: [],
      model_messages: { instructions_template: instructions }
    }]
  };
}

export function buildRestrictedLaunch(environment) {
  const launch = buildAppServerLaunch({ ...environment,
    CODEX_MODEL_SHELL_TYPE: "disabled", CODEX_MODEL_APPLY_PATCH_TOOL_TYPE: "none" });
  // goals：线程目标会让 Codex 绕过任务队列自动连续发起轮次；project_doc_max_bytes=0：workspace
  // 及其上级目录的 AGENTS.md 是用户数据，不能进入模型指令（角色指令走 instructions_template）。
  launch.args.push("-c", "features.goals=false", "-c", "project_doc_max_bytes=0",
    "-c", "features.shell_tool=false", "-c", "features.apply_patch_freeform=false",
    "-c", "agents.enabled=false", "-c", "features.view_image=false", "-c", "features.image_generation=false", "-c", "features.multi_agent=false", "-c", "features.apps=false", "-c", "features.hooks=false", "-c", "features.plugins=false");
  return launch;
}

export function buildAppServerLaunch(environment, instructions = "") {
  const args = ["app-server", "--listen", "stdio://"];
  const env = { ...environment };
  for (const key of Object.keys(env)) if (/^(DATABASE_URL|REDIS_URL|AGENT_DB_PASSWORD|REDIS_PASSWORD|PG[A-Z_]+)$/.test(key)) delete env[key];
  const model = environment.CODEX_MODEL?.trim() || undefined;
  if (model && /[\u0000-\u001f\u007f]/.test(model)) throw new Error("CODEX_MODEL 不能包含控制字符。");
  const timeoutMs = Number(environment.DEMO_TIMEOUT_MS || 180_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("DEMO_TIMEOUT_MS 必须是 1 到 2147483647 之间的整数。");
  }
  const catalog = buildModelCatalog(environment, instructions);
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
  return { args, env, model, catalog, timeoutMs, baseUrl: values.CODEX_BASE_URL, authMode: "apiKey" };
}
