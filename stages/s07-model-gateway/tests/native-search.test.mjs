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

test("搜索是会话配置：消息不能按轮覆盖，两轮派发都不携带搜索开关", async t => {
  const { rig, until } = await import("./helpers.mjs");
  const r = await rig(t);
  for (const field of ["webSearch", "web_search", "AGENT_WEB_SEARCH"]) {
    await assert.rejects(r.messages.submit({ threadId: r.session.id, clientMessageId: field, text: "查资料", [field]: "live" }),
      error => error.status === 400 && /只接受任务字段/.test(error.message));
  }
  for (const id of ["first", "second"]) {
    await r.submit("查资料", id);
    await until(() => r.messages.job(id).status === "running");
    r.rpc.finish(r.session.id);
    await until(() => r.messages.job(id).status === "completed");
  }
  const turns = r.rpc.calls.filter(call => call.method === "turn/start");
  assert.equal(turns.length, 2);
  for (const { params } of turns) {
    for (const field of ["webSearch", "web_search", "config"]) assert.equal(Object.hasOwn(params, field), false);
  }
});

test("假网关搜索自检：检查调用标记、请求工具与用量，口头声称搜索不能通过", async t => {
  const { checkGateway } = await import("../scripts/gateway-check.mjs");
  const requests = [];
  let emitSearchCall = true;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    const output = [{ type: "message", content: [{ type: "output_text", text: "我已联网搜索" }] }];
    if (body.tools && emitSearchCall) output.unshift({ type: "web_search_call" });
    return Response.json({ output, usage: { input_tokens: 7, output_tokens: 2 } });
  });
  const options = { environment, registry, model: "kimi/kimi-k2.7-code", search: true };
  const success = await checkGateway(options);
  assert.equal(success.exitCode, 0);
  assert.deepEqual([success.rows[0].chat, success.rows[0].search, success.rows[0].inputTokens, success.rows[0].outputTokens], [true, true, 14, 4]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.tools, undefined);
  assert.deepEqual(requests[1].body.tools, [{ type: "web_search", external_web_access: true }]);
  for (const request of requests) {
    assert.equal(request.url, "http://127.0.0.1:4330/v1/responses");
    assert.equal(request.headers.Authorization, `Bearer ${environment.AGENT_GATEWAY_KEY}`);
    assert.equal(request.body.input[0].content[0].type, "input_text");
    assert.ok(!JSON.stringify(request).includes(environment.KIMI_API_KEY));
  }
  emitSearchCall = false;
  const failure = await checkGateway(options);
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.rows[0].search, false);
  assert.match(failure.messages.join("\n"), /没有 web_search_call/);
  assert.match(failure.messages.join("\n"), /清单已声明 web_search，但实测失败/);
});
