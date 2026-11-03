import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModelRegistry, validateRegistry } from "../server/modules/gateway/index.mjs";
import { buildAppServerLaunch } from "../server/modules/codex/launch.mjs";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { fixture, installToolFixture, tempRoot } from "./helpers.mjs";

const registry = loadModelRegistry(path.resolve(import.meta.dirname, ".."));
const environment = { AGENT_GATEWAY_KEY: "sk-bf-test", KIMI_API_KEY: "test-kimi", DEEPSEEK_API_KEY: "test-deepseek" };
const launch = env => buildAppServerLaunch(env, "", { registry });

test("nativeTools 可省略或为空，仅 chat 模型可声明不重复的 web_search", () => {
  const id = "kimi/kimi-k2.7-code";
  for (const value of [undefined, [], ["web_search"]]) {
    const copy = structuredClone(registry);
    copy.models[id].nativeTools = value;
    assert.equal(validateRegistry(copy), copy);
  }
  for (const value of [null, "web_search", ["search_web"], [1], ["web_search", "web_search"]]) {
    const copy = structuredClone(registry);
    copy.models[id].nativeTools = value;
    assert.throws(() => validateRegistry(copy), /模型 kimi\/kimi-k2.7-code 的 nativeTools 必须是不重复的字符串数组，目前只允许 web_search/);
  }
  for (const value of [[], ["web_search"]]) {
    const copy = structuredClone(registry);
    copy.models["ollama/qwen3-embedding:0.6b"].nativeTools = value;
    assert.throws(() => validateRegistry(copy), /模型 ollama\/qwen3-embedding:0.6b 的 nativeTools 只能用于 purposes 含 chat/);
  }
});

test("联网搜索跟随实际默认模型，支持 CODEX_MODEL 覆盖、off，直连始终关闭", () => {
  for (const [env, expected] of [
    [environment, "live"],
    [{ ...environment, AGENT_WEB_SEARCH: "auto" }, "live"],
    [{ ...environment, CODEX_MODEL: "kimi/kimi-k2.6" }, "live"],
    [{ ...environment, KIMI_API_KEY: "" }, "disabled"],
    [{ ...environment, CODEX_MODEL: "deepseek/deepseek-flash" }, "disabled"],
    [{ ...environment, AGENT_WEB_SEARCH: "off" }, "disabled"],
    [fixture, "disabled"],
    [{ ...fixture, CODEX_MODEL: "kimi/kimi-k2.7-code" }, "disabled"],
    [{}, "disabled"],
  ]) {
    const result = launch(env);
    assert.equal(result.webSearch, expected);
    assert.ok(result.args.includes(`web_search="${expected}"`));
  }
  for (const value of ["live", "on", "AUTO", ""]) {
    assert.throws(() => launch({ ...environment, AGENT_WEB_SEARCH: value }), /AGENT_WEB_SEARCH 必须为 auto 或 off/);
    assert.throws(() => launch({ ...fixture, AGENT_WEB_SEARCH: value }), /AGENT_WEB_SEARCH 必须为 auto 或 off/);
  }
});

test("工作流启动校验：搜索开启时具体模型和场景都必须支持搜索，关闭时允许切换", t => {
  const root = installToolFixture(tempRoot(t), { article: true });
  const file = path.join(root, "agents/writing/agent.json");
  const definition = JSON.parse(fs.readFileSync(file, "utf8"));
  const configure = (model, env = environment) => {
    definition.agent.workflows.find(workflow => workflow.id === "write-article").steps[0].model = model;
    fs.writeFileSync(file, JSON.stringify(definition));
    const agent = new AgentDefinition(root);
    agent.configure({ launch: launch(env), memory: { enabled: false, use: false } }, { workspaceDir: path.join(root, "workspace") });
  };
  for (const model of ["fast", "deepseek/deepseek-flash"]) {
    assert.throws(() => configure(model), /Workflow write-article 的步骤 outline：模型 deepseek\/deepseek-flash.*换成支持搜索的模型.*AGENT_WEB_SEARCH=off/);
    assert.doesNotThrow(() => configure(model, { ...environment, AGENT_WEB_SEARCH: "off" }));
  }
  assert.doesNotThrow(() => configure("kimi/kimi-k2.6"));
  assert.doesNotThrow(() => configure("strong", { ...environment, DEEPSEEK_API_KEY: "" }));
  assert.doesNotThrow(() => configure(undefined));
});
