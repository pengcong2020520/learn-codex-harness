import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAppServerLaunch } from "../server/modules/codex/launch.mjs";
import { buildGatewayConfig, gatewayEndpoint, loadModelRegistry, modelEndpoint, validateRegistry } from "../server/modules/gateway/index.mjs";
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
  for (const { keyEnv } of Object.values(registry.providers)) {
    assert.match(compose, new RegExp(`^\\s+${keyEnv}: \\$\\{${keyEnv}:-\\}$`, "m"), `compose.yaml 的网关要传入 ${keyEnv}`);
    assert.ok(listed.includes(keyEnv), `remote.sh 的 PROVIDER_KEYS 要包含 ${keyEnv}`);
  }
  assert.equal(listed.length, Object.keys(registry.providers).length);
});

test("模型清单校验：写错的服务商、密钥变量、备用模型和推理档位都会被拦下", () => {
  const base = () => structuredClone(registry);
  const cases = [
    [r => { r.providers.Kimi = r.providers.kimi; }, /服务商名 Kimi/],
    [r => { r.providers.kimi.keyEnv = "CODEX_API_KEY"; }, /keyEnv 必须形如/],
    [r => { r.providers.openai.keyEnv = "KIMI_API_KEY"; }, /重复/],
    [r => { r.providers.kimi.baseUrl = "http://api.moonshot.cn"; }, /必须是 https/],
    [r => { r.models["nobody/x"] = { contextWindow: 1 }; }, /服务商已在 providers 中登记/],
    [r => { r.models["kimi/kimi-k2.7-code"].fallbacks = ["kimi/kimi-k2.7-code"]; }, /备用模型/],
    [r => { r.models["kimi/kimi-k2.7-code"].fallbacks = ["openai/none"]; }, /备用模型/],
    [r => { r.models["deepseek/deepseek-flash"].defaultReasoningLevel = "xhigh"; }, /defaultReasoningLevel/],
    [r => { r.models["kimi/kimi-k2.6"].contextWindow = 0; }, /contextWindow/],
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
  assert.deepEqual(config.providers.deepseek, { keys: [{ name: "deepseek", value: "env.DEEPSEEK_API_KEY", models: ["deepseek-flash"], weight: 1 }] }, "内置服务商不需要自定义配置");
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
  assert.deepEqual(config.governance.routing_rules.map(rule => rule.priority), [1, 2], "优先级在同一范围内不能重复");
});

test("网关配置：备用模型的服务商没有密钥时不写进备用链；默认模型没有密钥或不在清单里会报错", () => {
  const onlyKimi = buildGatewayConfig(registry, { ...gatewayEnv, DEEPSEEK_API_KEY: "" });
  assert.deepEqual(Object.keys(onlyKimi.providers), ["kimi"]);
  assert.deepEqual(onlyKimi.governance.routing_rules, [], "deepseek 未启用，kimi 没有可用的备用");
  assert.throws(() => buildGatewayConfig(registry, { ...gatewayEnv, KIMI_API_KEY: "" }), /KIMI_API_KEY/);
  assert.throws(() => buildGatewayConfig(registry, { ...gatewayEnv, CODEX_MODEL: "kimi-k2.7-code" }), /服务商\/模型名/);
  const withClaude = buildGatewayConfig(registry, { ...gatewayEnv, ANTHROPIC_API_KEY: "sk-ant-x" });
  assert.deepEqual(withClaude.providers.anthropic.keys[0].models, ["claude-sonnet-5-5"]);
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
  assert.deepEqual(Object.keys(config.providers), ["kimi"]);
  const written = fs.readFileSync(file, "utf8");
  assert.ok(!written.includes("sk-kimi-only") && !written.includes(env.match(/sk-bf-\w+/)[0]));

  const fresh = tempRoot(t);
  assert.equal(ensureGatewayKey(fresh), true);
  assert.equal(fs.statSync(path.join(fresh, ".env")).mode & 0o777, 0o600, "新建的 .env 只允许本人读写");
});
