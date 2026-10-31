// 配置模块：只在服务端读取模型密钥，不向客户端返回完整环境变量。
import { readFileSync } from "node:fs";
import path from "node:path";
import { selectAgentFile } from "../agents/selection.mjs";
import { parseEnv } from "node:util";
import { PROJECT_ROOT } from "../../../shared/paths.mjs";
import { buildRestrictedLaunch } from "../codex/launch.mjs";
export { buildAppServerLaunch, buildModelCatalog } from "../codex/launch.mjs";

function booleanValue(environment, name, fallback) {
  const value = environment[name]?.trim() || String(fallback);
  if (!["true", "false"].includes(value)) throw new Error(`${name} 必须为 true 或 false。`);
  return value === "true";
}

// ---------- 1. 配置读取：只读本项目 .env；终端环境变量优先 ----------
export function loadEnvironment(root = PROJECT_ROOT, inherited = process.env) {
  let fileValues;
  try {
    fileValues = parseEnv(readFileSync(path.join(root, ".env"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") fileValues = {};
    else throw new Error("无法读取项目 .env，请检查文件格式和权限。");
  }
  return { ...fileValues, ...inherited };
}

// ---------- 2. 输出保护与命令行选项 ----------
export function createLogRedactor(apiKey = "", additional = []) {
  const secrets = [...new Set([apiKey, apiKey.trim(), ...additional].filter(Boolean))]
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  const redact = value => {
    let text = typeof value === "string" ? value : JSON.stringify(value, (key, entry) =>
      /^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)$/i.test(key) ? "[REDACTED]" : entry
    );
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text;
  };
  // 流式文本逐段到达，密钥可能被切在两段之间。滑动窗口只扣住末尾「可能是某个密钥开头」的那一段，
  // 跨越切点的完整密钥整段留到下一次；其余文字脱敏后立即放行。end() 放行全部剩余文字。
  redact.stream = () => {
    let pending = "";
    const release = final => {
      let cut = pending.length;
      if (!final) {
        for (const secret of secrets) cut = Math.min(cut, pending.length - partialSuffix(pending, secret));
        for (let moved = true; moved;) {
          moved = false;
          for (const secret of secrets) {
            const index = pending.indexOf(secret, Math.max(0, cut - secret.length + 1));
            if (index !== -1 && index < cut) { cut = index; moved = true; }
          }
        }
      }
      const text = redact(pending.slice(0, cut));
      pending = pending.slice(cut);
      return text;
    };
    return { push: chunk => { pending += chunk; return release(false); }, end: () => release(true) };
  };
  return redact;
}

// text 末尾与 secret 开头重合的最长长度；完整出现的 secret 不算在内。
function partialSuffix(text, secret) {
  for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
    if (text.charCodeAt(text.length - size) === secret.charCodeAt(0) && text.endsWith(secret.slice(0, size))) return size;
  }
  return 0;
}


export function loadServerConfig(root = PROJECT_ROOT, inherited = process.env) {
  const environment = loadEnvironment(root, inherited);
  const port = Number(environment.AGENT_PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_PORT 必须是 1 到 65535 的整数。");
  const turnTimeoutMs = Number(environment.AGENT_TURN_TIMEOUT_MS || 600_000);
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > 2_147_483_647) throw new Error("AGENT_TURN_TIMEOUT_MS 必须是有效的正整数毫秒数。");
  const launch = buildRestrictedLaunch(environment);
  const rag = { chromaUrl: environment.CHROMA_URL, url: environment.EMBEDDING_BASE_URL,
    apiKey: environment.EMBEDDING_API_KEY, model: environment.EMBEDDING_MODEL,
    dimensions: Number(environment.EMBEDDING_DIMENSIONS) };
  const data = { databaseUrl: environment.DATABASE_URL, redisUrl: environment.REDIS_URL };
  // Product credentials must not leak into Codex, model tool subprocesses or protocol logs.
  for (const key of Object.keys(launch.env)) if (/^(DATABASE_URL|REDIS_URL|PG[A-Z_]+|EMBEDDING_[A-Z_]+|CHROMA_[A-Z_]+)$/.test(key)) delete launch.env[key];
  const memoryModel = name => {
    const model = environment[name]?.trim() || launch.model;
    if (model && (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model))) throw new Error(`${name} 模型名称无效。`);
    return model;
  };
  const minIdleHours = Number(environment.AGENT_MEMORY_MIN_IDLE_HOURS?.trim() || 6);
  if (!Number.isInteger(minIdleHours) || minIdleHours < 1 || minIdleHours > 48) throw new Error("AGENT_MEMORY_MIN_IDLE_HOURS 必须是 1 到 48 的整数。");
  const memory = {
    enabled: booleanValue(environment, "AGENT_MEMORY_ENABLED", false),
    use: booleanValue(environment, "AGENT_MEMORY_USE", true),
    generate: booleanValue(environment, "AGENT_MEMORY_GENERATE", true),
    extractModel: memoryModel("AGENT_MEMORY_EXTRACT_MODEL"),
    consolidationModel: memoryModel("AGENT_MEMORY_CONSOLIDATION_MODEL"), minIdleHours
  };
  return { root, agentFile: selectAgentFile(root, environment.AGENT_DEFINITION), port, host: "127.0.0.1", turnTimeoutMs, launch, memory, data, rag };
}
