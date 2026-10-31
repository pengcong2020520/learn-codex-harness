// 只构造本次 App Server 的启动参数，不修改全局配置或登录凭据。
export function buildAppServerLaunch(environment = process.env) {
  const args = ["app-server", "--listen", "stdio://"];
  const env = { ...environment };
  const model = environment.CODEX_MODEL?.trim() || undefined;
  const useApiKey = environment.CODEX_API_KEY !== undefined ||
    environment.CODEX_BASE_URL !== undefined;

  // 未选择 API Key 路线时，兼容原有的 Codex 登录方式。
  if (!useApiKey) return { args, env, model, authMode: "existing" };

  const values = Object.fromEntries(
    ["CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL"].map(
      (name) => [name, environment[name]?.trim() || ""],
    ),
  );
  const missing = Object.keys(values).filter((name) => !values[name]);
  if (missing.length) {
    throw new Error(`API Key 模式缺少 ${missing.join("、")}；请检查项目根目录的 .env。`);
  }
  if (Object.values(values).some((value) => /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("API 配置不能包含换行或控制字符；请检查 .env。");
  }

  let endpoint;
  try {
    endpoint = new URL(values.CODEX_BASE_URL);
  } catch {
    // 不回显输入，避免错误的 URL 中恰好含有密钥。
    throw new Error("CODEX_BASE_URL 必须是完整的 API 基础地址，例如 https://api.openai.com/v1。");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("CODEX_BASE_URL 必须使用 HTTPS；只有本机回环地址允许 HTTP。");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("CODEX_BASE_URL 不应包含用户名、密码、查询参数或片段；密钥请单独放入 CODEX_API_KEY。");
  }
  if (/\/(responses|chat\/completions)\/?$/.test(endpoint.pathname)) {
    throw new Error("CODEX_BASE_URL 应填写 API 基础地址，不要在末尾添加 /responses 或 /chat/completions。");
  }

  args.push(
    "-c", 'model_provider="codex_harness_demo_api"',
    "-c", `model=${JSON.stringify(values.CODEX_MODEL)}`,
    "-c", 'model_providers.codex_harness_demo_api.name="Harness Demo API"',
    "-c", `model_providers.codex_harness_demo_api.base_url=${JSON.stringify(values.CODEX_BASE_URL)}`,
    "-c", 'model_providers.codex_harness_demo_api.env_key="CODEX_API_KEY"',
    "-c", 'model_providers.codex_harness_demo_api.wire_api="responses"',
    "-c", 'model_providers.codex_harness_demo_api.requires_openai_auth=false',
  );
  // 真正的 Key 只经环境变量传给子进程，不放入命令参数或 JSON-RPC 消息。
  env.CODEX_API_KEY = values.CODEX_API_KEY;
  return { args, env, model: values.CODEX_MODEL, authMode: "apiKey" };
}

// 调试输出的补充保护：隐藏已知 Key 及常见认证字段；不修改实际协议消息。
export function createLogRedactor(apiKey = "") {
  const secrets = [...new Set([apiKey, apiKey.trim()].filter(Boolean))]
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  return (value) => {
    let text = typeof value === "string" ? value : JSON.stringify(value, (key, entry) =>
      /^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)$/i.test(key)
        ? "[REDACTED]" : entry,
    );
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text;
  };
}
