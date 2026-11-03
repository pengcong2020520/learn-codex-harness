import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModelRegistry } from "../server/modules/gateway/index.mjs";
import { createModelRouter } from "../server/modules/gateway/router.mjs";
import { buildAppServerLaunch } from "../server/modules/codex/launch.mjs";

const registry = loadModelRegistry(path.resolve(import.meta.dirname, ".."));
const deepseekOnly = { DEEPSEEK_API_KEY: "sk-d" };
const kimiAndDeepseek = { KIMI_API_KEY: "sk-k", DEEPSEEK_API_KEY: "sk-d" };

test("默认对话模型：按 routes.chat 的顺序取第一个服务商已启用的；CODEX_MODEL 可以覆盖", () => {
  assert.equal(createModelRouter(registry, kimiAndDeepseek).resolve().id, "kimi/kimi-k2.7-code");
  assert.equal(createModelRouter(registry, deepseekOnly).resolve().id, "deepseek/deepseek-flash", "Kimi 没有密钥就顺延");
  const chosen = createModelRouter(registry, { ...kimiAndDeepseek, CODEX_MODEL: "deepseek/deepseek-flash" }).resolve();
  assert.deepEqual([chosen.id, chosen.provider, chosen.model, chosen.source], ["deepseek/deepseek-flash", "deepseek", "deepseek-flash", "CODEX_MODEL"]);
  assert.throws(() => createModelRouter(registry, { ...deepseekOnly, CODEX_MODEL: "kimi/kimi-k2.7-code" }).resolve(), /kimi\/kimi-k2.7-code：服务商未启用（.env 里缺 KIMI_API_KEY）/);
});

test("指定模型或场景：工作流步骤写具体模型（带 /）或场景名；写错立即报错并说明原因", () => {
  const router = createModelRouter(registry, kimiAndDeepseek);
  assert.equal(router.resolve({ model: "deepseek/deepseek-v4-pro" }).id, "deepseek/deepseek-v4-pro");
  assert.equal(router.resolve({ model: "fast" }).id, "deepseek/deepseek-flash");
  assert.equal(router.resolve({ model: "strong" }).id, "deepseek/deepseek-v4-pro");
  assert.equal(createModelRouter(registry, { KIMI_API_KEY: "sk-k" }).resolve({ model: "strong" }).id, "kimi/kimi-k2.7-code", "场景里的第一候选不可用就顺延");
  assert.throws(() => router.resolve({ model: "nobody/x" }), /不在 config\/models.json 里/);
  assert.throws(() => router.resolve({ model: "fastest" }), /没有名为 fastest 的场景/);
  assert.throws(() => router.resolve({ model: "ollama/qwen3-embedding:0.6b" }), /不能做对话/);
  assert.throws(() => router.resolve({ purpose: "painting" }), /未知的模型用途/);
});

test("按能力挑选：要看图就跳过只能读文字的，要长上下文就跳过上下文不够的", () => {
  const router = createModelRouter(registry, { KIMI_API_KEY: "sk-k", ZHIPU_API_KEY: "z" });
  assert.equal(router.resolve({ model: "strong" }).id, "kimi/kimi-k2.7-code");
  assert.equal(router.resolve({ model: "strong", needs: { contextTokens: 500000 } }).id, "zhipu/glm-5.3", "Kimi 只有 26 万上下文");
  assert.throws(() => router.resolve({ model: "strong", needs: { contextTokens: 500000, image: true } }), /zhipu\/glm-5.3：不能看图/);
});

test("向量等其他用途：本地 Ollama 填了地址才启用；没有可用模型时报错说明缺什么", () => {
  const embedding = createModelRouter(registry, { ...deepseekOnly, OLLAMA_BASE_URL: "http://ollama:11434" }).resolve({ purpose: "embedding" });
  assert.deepEqual([embedding.id, embedding.spec.dimensions], ["ollama/qwen3-embedding:0.6b", 1024]);
  assert.throws(() => createModelRouter(registry, deepseekOnly).resolve({ purpose: "embedding" }), error =>
    error.code === "MODEL_UNAVAILABLE" && /没有可用的向量模型（routes.embedding）.*缺 OLLAMA_BASE_URL/.test(error.message));
  assert.throws(() => createModelRouter(registry, deepseekOnly).resolve({ purpose: "image" }), /没有可用的生图模型（routes.image）。没有登记候选/);
});

test("Codex 的模型目录：网关模式下放所有可用的对话模型，默认的排第一，向量模型不进目录", () => {
  const environment = { AGENT_GATEWAY_KEY: "sk-bf-x", CODEX_MODEL_CATALOG_ENABLED: "true", ...kimiAndDeepseek, OLLAMA_BASE_URL: "http://ollama:11434" };
  const router = createModelRouter(registry, environment);
  assert.deepEqual(router.chatModels(), ["kimi/kimi-k2.7-code", "kimi/kimi-k2.6", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  const launch = buildAppServerLaunch(environment, "角色", { registry });
  assert.ok(launch.args.includes('model="kimi/kimi-k2.7-code"'), "没写 CODEX_MODEL 时默认模型来自路由表");
  assert.equal(launch.model, "kimi/kimi-k2.7-code");
  assert.deepEqual(launch.catalog.models.map(entry => [entry.slug, entry.priority]), [["kimi/kimi-k2.7-code", 1], ["kimi/kimi-k2.6", 2], ["deepseek/deepseek-flash", 3], ["deepseek/deepseek-v4-pro", 4]]);
  assert.deepEqual(launch.catalog.models[2].supported_reasoning_levels.map(level => level.effort), ["low", "high", "max"], "每个模型用自己的能力信息");
  assert.equal(launch.router.resolve({ model: "fast" }).id, "deepseek/deepseek-flash");
});

test("RAG 的向量模型经网关：配了向量库才接；地址和密钥用网关的，模型和维数来自路由；挑不到时说明原因", async t => {
  const fs = await import("node:fs");
  const { tempRoot } = await import("./helpers.mjs");
  const { loadServerConfig } = await import("../server/modules/config/index.mjs");
  const { createRag } = await import("../server/modules/knowledge/rag.mjs");
  const root = tempRoot(t);
  fs.cpSync(path.resolve(import.meta.dirname, "../config/models.json"), path.join(root, "config/models.json"));
  const base = { AGENT_GATEWAY_KEY: "sk-bf-rag-test", DEEPSEEK_API_KEY: "sk-d" };
  const viaGateway = loadServerConfig(root, { ...base, CHROMA_URL: "http://127.0.0.1:8000", OLLAMA_BASE_URL: "http://ollama:11434" }).rag;
  assert.deepEqual([viaGateway.url, viaGateway.apiKey, viaGateway.model, viaGateway.dimensions],
    ["http://127.0.0.1:4330/v1", "sk-bf-rag-test", "ollama/qwen3-embedding:0.6b", 1024]);
  assert.equal(loadServerConfig(root, { ...base, OLLAMA_BASE_URL: "http://ollama:11434" }).rag.url, undefined, "没配向量库就不接");
  const missing = loadServerConfig(root, { ...base, CHROMA_URL: "http://127.0.0.1:8000" }).rag;
  assert.match(missing.unavailable, /缺 OLLAMA_BASE_URL/);
  await assert.rejects(createRag(missing, root), /已配置 CHROMA_URL，但没有可用的向量模型：.*缺 OLLAMA_BASE_URL/);
  const direct = loadServerConfig(root, { ...base, CHROMA_URL: "http://127.0.0.1:8000", EMBEDDING_BASE_URL: "https://embed.example/v1", EMBEDDING_MODEL: "m", EMBEDDING_DIMENSIONS: "8" }).rag;
  assert.deepEqual([direct.url, direct.model, direct.dimensions], ["https://embed.example/v1", "m", 8], "单独配置的 EMBEDDING_* 优先");
});
