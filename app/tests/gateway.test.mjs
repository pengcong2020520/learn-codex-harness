import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAppServerLaunch } from "../server/modules/codex/launch.mjs";
import { buildGatewayConfig, buildModelParameters, gatewayEndpoint, loadModelRegistry, modelEndpoint, validateRegistry } from "../server/modules/gateway/index.mjs";
import { ensureGatewayKey, writeGatewayConfig } from "../scripts/gateway-config.mjs";
import { tempRoot } from "./helpers.mjs";

const app = path.resolve(import.meta.dirname, "..");
const registry = loadModelRegistry(app);
const keys = { KIMI_API_KEY: "sk-kimi-secret-123", DEEPSEEK_API_KEY: "sk-deepseek-secret-456" };
const gatewayEnv = { AGENT_GATEWAY_KEY: "sk-bf-local-789", CODEX_MODEL: "kimi/kimi-k2.7-code", CODEX_MODEL_CATALOG_ENABLED: "true", ...keys };

test("内置模型清单合法；每家的密钥变量在 compose 与部署脚本里都有登记", () => {
  assert.ok(registry.models["kimi/kimi-k2.7-code"] && registry.models["deepseek/deepseek-flash"]);
  const compose = fs.readFileSync(path.join(app, "compose.yaml"), "utf8"), remote = fs.readFileSync(path.join(app, "deploy/remote.sh"), "utf8");
  const listed = remote.match(/^PROVIDER_KEYS='([^']+)'/m)[1].split("|");
  // 密钥用环境变量引用传进网关；不需要密钥的服务（如本地 Ollama）只有地址，地址直接写进生成的配置。
  const keyEnvs = Object.values(registry.providers).map(provider => provider.keyEnv).filter(Boolean);
  for (const keyEnv of keyEnvs) {
    assert.match(compose, new RegExp(`^\\s+${keyEnv}: \\$\\{${keyEnv}:-\\}$`, "m"), `compose.yaml 的网关要传入 ${keyEnv}`);
    assert.ok(listed.includes(keyEnv), `remote.sh 的 PROVIDER_KEYS 要包含 ${keyEnv}`);
  }
  assert.equal(listed.length, keyEnvs.length);
  // 每个模型都标了用途；路由表里每种用途的候选都存在。
  for (const [id, spec] of Object.entries(registry.models)) assert.ok(spec.purposes.length, id);
  assert.deepEqual(Object.keys(registry.routes).sort(), ["chat", "embedding"]);
});

test("模型清单校验：写错的服务商、密钥变量、备用模型和推理档位都会被拦下", () => {
  const base = () => structuredClone(registry);
  const cases = [
    [r => { r.providers.Kimi = r.providers.kimi; }, /服务商名 Kimi/],
    [r => { r.providers.kimi.keyEnv = "CODEX_API_KEY"; }, /keyEnv 必须形如/],
    [r => { r.providers.openai.keyEnv = "KIMI_API_KEY"; }, /被多个服务商使用/],
    [r => { r.providers.kimi.baseUrl = "http://api.moonshot.cn"; }, /必须是 https；只有容器名或本机地址可以用 http/],
    [r => { delete r.providers.kimi.keyEnv; }, /至少要有 keyEnv 或 baseUrlEnv/],
    [r => { r.providers.ollama.baseUrlEnv = "OLLAMA_API_KEY"; }, /baseUrlEnv 必须是大写变量名，且不能以 _API_KEY 结尾/],
    [r => { r.models["nobody/x"] = { purposes: ["chat"], contextWindow: 1 }; }, /服务商已在 providers 中登记/],
    [r => { delete r.models["kimi/kimi-k2.6"].purposes; }, /purposes 必须是不重复的用途/],
    [r => { r.models["kimi/kimi-k2.6"].purposes = ["chat", "painting"]; }, /purposes 必须是不重复的用途/],
    [r => { delete r.models["ollama/qwen3-embedding:0.6b"].dimensions; }, /dimensions 必须是正整数/],
    [r => { r.models["kimi/kimi-k2.7-code"].fallbacks = ["ollama/qwen3-embedding:0.6b"]; }, /要能做它的全部用途/],
    [r => { r.routes.embedding = ["kimi/kimi-k2.7-code"]; }, /routes.embedding 里的 kimi\/kimi-k2.7-code 必须是清单里用途包含 embedding 的模型/],
    [r => { r.routes.painting = ["kimi/kimi-k2.7-code"]; }, /不是已知用途/],
    [r => { r.scenes.fast = ["ollama/qwen3-embedding:0.6b"]; }, /必须是清单里的对话模型/],
    [r => { r.scenes["Fast/1"] = ["kimi/kimi-k2.7-code"]; }, /场景名/],
    [r => { r.models["kimi/kimi-k2.7-code"].fallbacks = ["kimi/kimi-k2.7-code"]; }, /备用模型/],
    [r => { r.models["kimi/kimi-k2.7-code"].fallbacks = ["openai/none"]; }, /备用模型/],
    [r => { r.models["deepseek/deepseek-flash"].defaultReasoningLevel = "xhigh"; }, /defaultReasoningLevel/],
    [r => { r.models["kimi/kimi-k2.6"].contextWindow = 0; }, /contextWindow/],
    [r => { delete r.models["zhipu/glm-5.3"].maxOutputTokens; }, /走 Claude 格式接口，必须填 maxOutputTokens/],
    [r => { r.models["kimi/kimi-k2.6"].maxOutputTokens = 1.5; }, /maxOutputTokens 必须是正整数/],
  ];
  for (const [mutate, message] of cases) {
    const r = base(); mutate(r);
    assert.throws(() => validateRegistry(r), message);
  }
});

test("网关配置：只启用填了密钥的服务商，配置里只有环境变量引用、没有密钥本身", () => {
  const config = buildGatewayConfig(registry, gatewayEnv);
  assert.deepEqual(Object.keys(config.providers).sort(), ["deepseek", "kimi"]);
  assert.deepEqual(config.providers.kimi, { keys: [{ name: "kimi", value: "env.KIMI_API_KEY", models: ["kimi-k2.7-code", "kimi-k2.6"], weight: 1 }],
    network_config: { base_url: "https://api.moonshot.cn" }, custom_provider_config: { base_provider_type: "openai" } });
  assert.deepEqual(config.providers.deepseek, { keys: [{ name: "deepseek", value: "env.DEEPSEEK_API_KEY", models: ["deepseek-flash", "deepseek-v4-pro"], weight: 1 }] }, "内置服务商不需要自定义配置");
  assert.equal(config.governance.virtual_keys[0].value, "env.AGENT_GATEWAY_KEY");
  assert.equal(config.source_of_truth, "config.json");
  assert.equal(config.client.disable_content_logging, true);
  assert.equal(config.logs_store.enabled, false);
  const text = JSON.stringify(config);
  for (const secret of [...Object.values(keys), gatewayEnv.AGENT_GATEWAY_KEY]) assert.ok(!text.includes(secret), "配置文件不含密钥");

  const rules = Object.fromEntries(config.governance.routing_rules.map(rule => [rule.targets[0].model, rule]));
  assert.equal(rules["kimi-k2.7-code"].cel_expression, 'provider == "kimi" && model == "kimi-k2.7-code"');
  assert.deepEqual(rules["kimi-k2.7-code"].fallbacks, ["deepseek/deepseek-flash"]);
  assert.deepEqual(rules["deepseek-flash"].fallbacks, ["kimi/kimi-k2.7-code"]);
  assert.deepEqual(rules["deepseek-v4-pro"].fallbacks, ["deepseek/deepseek-flash"]);
  assert.equal(rules["glm-5.3"], undefined, "智谱没有密钥，它的备用规则不写进去");
  const priorities = config.governance.routing_rules.map(rule => rule.priority);
  assert.deepEqual(priorities, priorities.map((_, index) => index + 1), "优先级在同一范围内不能重复");
});

test("网关配置：备用模型的服务商没有密钥时不写进备用链；一家都没启用会报错；本地 Ollama 按地址启用、不需要密钥", () => {
  const onlyKimi = buildGatewayConfig(registry, { ...gatewayEnv, DEEPSEEK_API_KEY: "" });
  assert.deepEqual(Object.keys(onlyKimi.providers), ["kimi"]);
  assert.deepEqual(onlyKimi.governance.routing_rules, [], "deepseek 未启用，kimi 没有可用的备用");
  assert.throws(() => buildGatewayConfig(registry, { AGENT_GATEWAY_KEY: "sk-bf-x" }), /没有启用任何模型服务商/);
  const withOllama = buildGatewayConfig(registry, { ...gatewayEnv, OLLAMA_BASE_URL: "http://ollama:11434" });
  assert.deepEqual(withOllama.providers.ollama, { keys: [{ name: "ollama", value: "", models: ["qwen3-embedding:0.6b"], weight: 1, ollama_key_config: { url: "http://ollama:11434" } }],
    network_config: { base_url: "http://ollama:11434", allow_private_network: true } }, "容器名地址属于内网，要显式放行");
  assert.throws(() => buildGatewayConfig(registry, { ...gatewayEnv, OLLAMA_BASE_URL: "http://ollama.example.com" }), /OLLAMA_BASE_URL 必须是 https/);
  const withClaude = buildGatewayConfig(registry, { ...gatewayEnv, ANTHROPIC_API_KEY: "sk-ant-x" });
  assert.deepEqual(withClaude.providers.anthropic.keys[0].models, ["claude-sonnet-5-5"]);
  // 智谱没有 OpenAI 新接口，按 Claude 格式接入：自定义服务商、接口类型 anthropic、地址指向它的 Claude 兼容接口。
  const withGlm = buildGatewayConfig(registry, { ...gatewayEnv, ZHIPU_API_KEY: "zhipu-x" });
  assert.deepEqual(withGlm.providers.zhipu, { keys: [{ name: "zhipu", value: "env.ZHIPU_API_KEY", models: ["glm-5.3", "glm-5.3-flash"], weight: 1 }],
    network_config: { base_url: "https://open.bigmodel.cn/api/anthropic" }, custom_provider_config: { base_provider_type: "anthropic" } });
});

test("模型参数表：只放已启用服务商的模型，键是“服务商/模型名”；网关用本地参数表，长输出不再被默认的 4096 截断", () => {
  const params = buildModelParameters(registry, { ...gatewayEnv, ZHIPU_API_KEY: "zhipu-x" });
  assert.deepEqual(Object.keys(params).sort(), ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "kimi/kimi-k2.6", "kimi/kimi-k2.7-code", "zhipu/glm-5.3", "zhipu/glm-5.3-flash"]);
  assert.deepEqual(params["zhipu/glm-5.3-flash"], { provider: "zhipu", mode: "chat", max_input_tokens: 1000000, max_output_tokens: 65536, max_tokens: 65536 });
  assert.equal(params["kimi/kimi-k2.7-code"].max_output_tokens, undefined, "原样转发的模型不用填，网关不替它设上限");
  assert.equal(buildGatewayConfig(registry, gatewayEnv).framework.pricing.model_parameters_url, "file:///app/data/model-parameters.json");
  const compose = fs.readFileSync(path.join(app, "compose.yaml"), "utf8");
  assert.match(compose, /\.\/\.data\/gateway\/model-parameters\.json:\/app\/data\/model-parameters\.json:ro/, "参数表要挂进网关容器");
});

test("连接参数：网关模式指向本机网关；与直连的三项同时设置会报错", () => {
  assert.deepEqual(gatewayEndpoint({ AGENT_GATEWAY_KEY: "sk-bf-k" }), { baseUrl: "http://127.0.0.1:4330/v1", apiKey: "sk-bf-k", port: 4330 });
  assert.equal(gatewayEndpoint({ AGENT_GATEWAY_KEY: "sk-bf-k", AGENT_GATEWAY_PORT: "5000" }).baseUrl, "http://127.0.0.1:5000/v1");
  assert.throws(() => gatewayEndpoint({ AGENT_GATEWAY_KEY: "sk-gw-k" }), /必须以 sk-bf- 开头/);
  assert.equal(gatewayEndpoint({ AGENT_GATEWAY_KEY: "  " }), null);
  assert.throws(() => gatewayEndpoint({ AGENT_GATEWAY_KEY: "sk-bf-k", CODEX_BASE_URL: "https://api.deepseek.com" }), /不要再设置 CODEX_BASE_URL/);
  assert.throws(() => gatewayEndpoint({ AGENT_GATEWAY_KEY: "sk-bf-k", AGENT_GATEWAY_PORT: "70000" }), /AGENT_GATEWAY_PORT/);
  assert.deepEqual(modelEndpoint({ CODEX_BASE_URL: "https://x.example/v1", CODEX_API_KEY: "d" }), { baseUrl: "https://x.example/v1", apiKey: "d" });
});

test("网关模式启动 Codex：接口与密钥换成网关的，各家密钥不进 Codex 环境，模型能力取自清单", () => {
  const launch = buildAppServerLaunch({ ...gatewayEnv, OPENAI_API_KEY: "sk-openai-x", TAVILY_API_KEY: "tvly-x", PATH: "/usr/bin" }, "角色", { registry });
  assert.ok(launch.args.includes('model_providers.project_api.base_url="http://127.0.0.1:4330/v1"'));
  assert.ok(launch.args.includes('model="kimi/kimi-k2.7-code"'));
  assert.equal(launch.env.CODEX_API_KEY, "sk-bf-local-789");
  for (const name of ["KIMI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "TAVILY_API_KEY", "AGENT_GATEWAY_KEY"]) assert.equal(launch.env[name], undefined, name);
  assert.equal(launch.env.PATH, "/usr/bin");
  assert.equal(launch.gateway, true);
  assert.ok(!launch.args.join(" ").includes("sk-"), "密钥不进启动参数");
  const [entry] = launch.catalog.models;
  assert.equal(entry.slug, "kimi/kimi-k2.7-code");
  assert.equal(entry.display_name, "Kimi K2.7 Code");
  assert.equal(entry.context_window, 262144);
  assert.deepEqual(entry.supported_reasoning_levels, []);
  assert.equal(entry.default_reasoning_level, null);
  assert.equal(entry.default_verbosity, "low");
  assert.equal(entry.truncation_policy.limit, 10000, "工具输出上限仍是本脚手架的设置");

  const deepseek = buildAppServerLaunch({ ...gatewayEnv, CODEX_MODEL: "deepseek/deepseek-flash" }, "", { registry }).catalog.models[0];
  assert.deepEqual(deepseek.supported_reasoning_levels.map(level => level.effort), ["low", "high", "max"]);
  assert.equal(deepseek.default_reasoning_level, "high");
});

test("直连模式不变：清单里没有的模型读 .env 的 CODEX_MODEL_*，其他服务的密钥同样不进 Codex", () => {
  const launch = buildAppServerLaunch({ CODEX_API_KEY: "sk-direct", CODEX_BASE_URL: "https://api.deepseek.com", CODEX_MODEL: "deepseek-flash",
    CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", CODEX_MODEL_DISPLAY_NAME: "直连模型", OPENAI_API_KEY: "sk-other" }, "", { registry });
  assert.equal(launch.env.CODEX_API_KEY, "sk-direct");
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.gateway, false);
  assert.equal(launch.catalog.models[0].display_name, "直连模型");
  assert.equal(launch.catalog.models[0].context_window, 128000);
});

test("生成网关配置文件与访问密钥：文件不含密钥；密钥只填空行或追加，已有的不覆盖", t => {
  const root = tempRoot(t);
  fs.cpSync(path.join(app, "config/models.json"), path.join(root, "config/models.json"));
  fs.writeFileSync(path.join(root, ".env"), "AGENT_PORT=4317\nAGENT_GATEWAY_KEY=\nCODEX_MODEL=kimi/kimi-k2.7-code\n");
  assert.throws(() => writeGatewayConfig(root, {}), /没有启用模型网关/);

  assert.equal(ensureGatewayKey(root), true);
  const env = fs.readFileSync(path.join(root, ".env"), "utf8");
  assert.match(env, /^AGENT_GATEWAY_KEY=sk-bf-[0-9a-f]{48}$/m);
  assert.equal(env.match(/^AGENT_GATEWAY_KEY=/gm).length, 1, "填在原来的空行上，不重复");
  assert.equal(ensureGatewayKey(root), false);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), env, "已有密钥不改动");

  const { file, config } = writeGatewayConfig(root, { KIMI_API_KEY: "sk-kimi-only" });
  assert.equal(path.relative(root, file), ".data/gateway/config.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  const params = path.join(root, ".data/gateway/model-parameters.json");
  assert.equal(fs.statSync(params).mode & 0o777, 0o644);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(params, "utf8"))), ["kimi/kimi-k2.7-code", "kimi/kimi-k2.6"]);
  assert.deepEqual(Object.keys(config.providers), ["kimi"]);
  const written = fs.readFileSync(file, "utf8");
  assert.ok(!written.includes("sk-kimi-only") && !written.includes(env.match(/sk-bf-\w+/)[0]));

  const fresh = tempRoot(t);
  assert.equal(ensureGatewayKey(fresh), true);
  assert.equal(fs.statSync(path.join(fresh, ".env")).mode & 0o777, 0o600, "新建的 .env 只允许本人读写");
});

test("放进容器：网关地址可以指到容器名；容器名走 http 允许，外部地址的 http 仍拒绝；监听地址只能是本机或全部网卡", async t => {
  const { loadServerConfig } = await import("../server/modules/config/index.mjs");
  assert.equal(gatewayEndpoint({ AGENT_GATEWAY_KEY: "sk-bf-k", AGENT_GATEWAY_URL: "http://gateway:8080/v1" }).baseUrl, "http://gateway:8080/v1");
  assert.throws(() => gatewayEndpoint({ AGENT_GATEWAY_KEY: "sk-bf-k", AGENT_GATEWAY_URL: "http://gateway.example.com/v1" }), /AGENT_GATEWAY_URL 必须是 https/);
  const launch = buildAppServerLaunch({ ...gatewayEnv, AGENT_GATEWAY_URL: "http://gateway:8080/v1" }, "", { registry });
  assert.ok(launch.args.includes('model_providers.project_api.base_url="http://gateway:8080/v1"'));
  assert.throws(() => buildAppServerLaunch({ CODEX_API_KEY: "k", CODEX_BASE_URL: "http://provider.example/v1", CODEX_MODEL: "m" }), /只有本机回环地址或容器名允许 HTTP/);
  const root = tempRoot(t);
  assert.equal(loadServerConfig(root, { AGENT_LISTEN_HOST: "0.0.0.0" }).host, "0.0.0.0");
  assert.equal(loadServerConfig(root, {}).host, "127.0.0.1");
  assert.throws(() => loadServerConfig(root, { AGENT_LISTEN_HOST: "10.0.0.5" }), /AGENT_LISTEN_HOST 只能是/);
});
