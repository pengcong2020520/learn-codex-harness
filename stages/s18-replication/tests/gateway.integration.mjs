// 模型网关集成测试：真 Bifrost 容器（compose.yaml 里锁定的镜像）+ 本机模拟的两家模型服务。
// 不读取 .env，不调用真实模型；需要 Docker（npm run test:gateway）。没有 Docker 时跳过。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { answer } from "./responses-fixture.mjs";
import { buildGatewayConfig, buildModelParameters, validateRegistry } from "../server/modules/gateway/index.mjs";

const app = path.resolve(import.meta.dirname, "..");
const image = fs.readFileSync(path.join(app, "compose.yaml"), "utf8").match(/^\s+image: (maximhq\/bifrost:\S+)$/m)[1];
const docker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// 两家模拟服务：alpha 永远余额不足（402），beta 按 Responses 协议回答。容器要从宿主访问它们，所以监听所有网卡（只在测试期间）。
async function upstream(t, handle) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path: request.url, body });
    handle(request, response, body);
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, url: `http://host.docker.internal:${server.address().port}` };
}

test("模型网关：没有访问密钥一律拒绝；主模型余额不足时自动改用备用；Responses 转 Claude 格式", { skip: !docker && "需要 Docker", timeout: 240000 }, async t => {
  const alpha = await upstream(t, (request, response) => {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Insufficient Balance", type: "insufficient_balance_error" } }));
  });
  const beta = await upstream(t, (request, response, body) => {
    if (!request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_direct", object: "response", status: "completed", model: body.model,
      output: [answer("好")], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } }));
  });

  // gamma 是 Claude 格式的服务：记下网关填的输出上限，回一段固定的文字。
  const gamma = await upstream(t, (request, response, body) => {
    if (!request.url.endsWith("/messages")) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "来自 gamma" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }));
  });

  // 网关配置：与正式部署同一个生成函数，只是把各家的地址换成本机模拟服务，并允许访问内网地址。
  const registry = validateRegistry({ schemaVersion: 1,
    providers: { alpha: { type: "openai", baseUrl: "https://alpha.example", keyEnv: "ALPHA_API_KEY" }, beta: { type: "openai", baseUrl: "https://beta.example", keyEnv: "BETA_API_KEY" },
      gamma: { type: "anthropic", baseUrl: "https://gamma.example", keyEnv: "GAMMA_API_KEY" } },
    models: { "alpha/model-a": { purposes: ["chat"], contextWindow: 128000, fallbacks: ["beta/model-b"] }, "beta/model-b": { purposes: ["chat"], contextWindow: 128000 },
      "gamma/model-c": { purposes: ["chat"], contextWindow: 128000, maxOutputTokens: 23456 } },
    routes: { chat: ["alpha/model-a"] } });
  const gatewayKey = `sk-bf-test-${randomBytes(8).toString("hex")}`;
  const environment = { AGENT_GATEWAY_KEY: gatewayKey, ALPHA_API_KEY: "sk-alpha-test", BETA_API_KEY: "sk-beta-test", GAMMA_API_KEY: "sk-gamma-test", CODEX_MODEL: "alpha/model-a" };
  const config = buildGatewayConfig(registry, environment);
  for (const [id, mock] of [["alpha", alpha], ["beta", beta], ["gamma", gamma]]) config.providers[id].network_config = { base_url: mock.url, allow_private_network: true, max_retries: 0 };
  // Colima 只把用户目录共享进虚拟机，配置文件放在项目的 .runs 下（不进 git）。
  fs.mkdirSync(path.join(app, ".runs"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(app, ".runs", "gateway-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "model-parameters.json"), JSON.stringify(buildModelParameters(registry, environment)), { mode: 0o644 });

  const name = `codex-harness-gateway-test-${randomBytes(4).toString("hex")}`;
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "--add-host", "host.docker.internal:host-gateway",
    "-e", `AGENT_GATEWAY_KEY=${gatewayKey}`, "-e", "ALPHA_API_KEY=sk-alpha-test", "-e", "BETA_API_KEY=sk-beta-test", "-e", "GAMMA_API_KEY=sk-gamma-test",
    "--tmpfs", "/app/data:uid=1000,gid=0,mode=0770", "-v", `${path.join(dir, "config.json")}:/app/data/config.json:ro`,
    "-v", `${path.join(dir, "model-parameters.json")}:/app/data/model-parameters.json:ro`,
    "-p", "127.0.0.1::8080", image], { stdio: "ignore" });
  t.after(() => spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }));
  const port = Number(execFileSync("docker", ["port", name, "8080/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${base}/health`).then(r => r.ok, () => false);
    if (ok) break;
    if (i === 59) assert.fail(`网关没有就绪：${execFileSync("docker", ["logs", name], { encoding: "utf8" }).slice(-800)}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const ask = key => fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: "alpha/model-a", input: "只回答：好", stream: false }) });
  assert.equal((await ask()).status, 401, "没有访问密钥");
  assert.equal((await ask("sk-bf-wrong")).status, 401, "错误的访问密钥");
  const direct = await ask(gatewayKey);
  assert.equal(direct.status, 200, await direct.clone().text());
  assert.match(JSON.stringify(await direct.json()), /好/);
  assert.ok(alpha.requests.some(request => request.path.endsWith("/responses")), "先试主模型");
  assert.equal(beta.requests.at(-1).body.model, "model-b", "备用服务收到的是它自己的模型名");
  assert.equal(alpha.requests.at(-1).body.model, "model-a");
  for (const { body } of [...alpha.requests, ...beta.requests]) assert.ok(!JSON.stringify(body).includes(gatewayKey), "访问密钥不会转给模型服务");

  // 翻译成 Claude 格式时，输出上限取自模型清单（Codex 不发上限；没有本地参数表时网关默认 4096，会截断长输出）。
  const claude = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gatewayKey}` },
    body: JSON.stringify({ model: "gamma/model-c", input: "只回答：好", stream: false }) });
  assert.equal(claude.status, 200, await claude.clone().text());
  assert.match(JSON.stringify(await claude.json()), /来自 gamma/);
  assert.equal(gamma.requests.filter(request => request.path.endsWith("/messages")).at(-1).body.max_tokens, 23456);

  // 本阶段不携带角色评估运行器；本课验证真实网关，Codex 工具闭环另见 test:codex-tools。

});

test("模型网关：每日 token 限流使用真实 Bifrost，首个请求耗尽额度后第二个请求被拒绝", { skip: !docker && "需要 Docker", timeout: 120000 }, async t => {
  const mock = await upstream(t, (request, response, body) => {
    // 网关启动时会探测上游（如列模型），这类请求没有请求体，不算模型调用。
    if (!request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_limit", object: "response", status: "completed", model: body.model,
      output: [answer("好")], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } }));
  });
  const registry = validateRegistry({ schemaVersion: 1, providers: { beta: { type: "openai", keyEnv: "BETA_API_KEY" } },
    models: { "beta/model-b": { purposes: ["chat"], contextWindow: 1000 } }, routes: { chat: ["beta/model-b"] } });
  const gatewayKey = `sk-bf-test-${randomBytes(8).toString("hex")}`;
  const environment = { AGENT_GATEWAY_KEY: gatewayKey, BETA_API_KEY: "sk-test-only", AGENT_GATEWAY_DAILY_TOKENS: "10" };
  const config = buildGatewayConfig(registry, environment);
  config.providers.beta.network_config = { base_url: mock.url, allow_private_network: true, max_retries: 0 };
  fs.mkdirSync(path.join(app, ".runs"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(app, ".runs", "gateway-limit-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "model-parameters.json"), JSON.stringify(buildModelParameters(registry, environment)), { mode: 0o644 });
  const name = `codex-harness-limit-test-${randomBytes(4).toString("hex")}`;
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "--add-host", "host.docker.internal:host-gateway",
    "-e", `AGENT_GATEWAY_KEY=${gatewayKey}`, "-e", "BETA_API_KEY=sk-test-only", "--tmpfs", "/app/data:uid=1000,gid=0,mode=0770",
    "-v", `${path.join(dir, "config.json")}:/app/data/config.json:ro`, "-v", `${path.join(dir, "model-parameters.json")}:/app/data/model-parameters.json:ro`,
    "-p", "127.0.0.1::8080", image], { stdio: "ignore" });
  t.after(() => spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }));
  const port = Number(execFileSync("docker", ["port", name, "8080/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/health`).then(r => r.ok, () => false)) break;
    if (i === 59) assert.fail("网关未就绪");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const ask = () => fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gatewayKey}` },
    body: JSON.stringify({ model: "beta/model-b", input: "好", stream: false }) });
  const first = await ask(); assert.equal(first.status, 200, await first.clone().text()); await first.json();
  // 网关在响应后的统计钩子里更新计数，给它完成写入的时间。
  await new Promise(resolve => setTimeout(resolve, 1000));
  const second = await ask();
  assert.equal(second.status, 429, await second.clone().text());
  assert.equal(mock.requests.filter(request => request.path.endsWith("/responses")).length, 1, "第二个请求在网关被拦，不到模型服务");
});
