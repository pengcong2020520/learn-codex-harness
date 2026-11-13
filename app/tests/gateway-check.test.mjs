import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkGateway, main } from "../scripts/gateway-check.mjs";
import { validateRegistry } from "../server/modules/gateway/index.mjs";

const registry = validateRegistry({ schemaVersion: 1,
  providers: { sample: { type: "openai", keyEnv: "SAMPLE_API_KEY" }, inactive: { type: "openai", keyEnv: "INACTIVE_API_KEY" } },
  models: {
    "sample/declared": { purposes: ["chat"], contextWindow: 1000, nativeTools: ["web_search"] },
    "sample/undeclared": { purposes: ["chat"], contextWindow: 1000 },
    "sample/embedding": { purposes: ["embedding"], dimensions: 8 },
    "inactive/chat": { purposes: ["chat"], contextWindow: 1000 },
  },
});
const message = { type: "message", content: [{ type: "output_text", text: "OK" }] };
const reply = (search = false) => ({ output: search ? [{ type: "web_search_call" }, message] : [message], usage: { input_tokens: 7, output_tokens: 2 } });

async function gateway(t, handler = body => reply(Boolean(body.tools))) {
  const requests = [];
  const environment = { AGENT_GATEWAY_KEY: "sk-bf-test-only", SAMPLE_API_KEY: "provider-test-only" };
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    const data = handler(body, res);
    if (data !== undefined) res.end(typeof data === "string" ? data : JSON.stringify(data));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  environment.AGENT_GATEWAY_PORT = String(server.address().port);
  return { environment, requests };
}

async function run(args, environment, options = {}) {
  const lines = [];
  const exitCode = await main(args, { environment, registry, log: line => lines.push(line), ...options });
  return { exitCode, output: lines.join("\n") };
}

test("经网关 Responses 测试已启用服务商的全部对话模型，默认搜索未测", async t => {
  const { environment, requests } = await gateway(t);
  const report = await checkGateway({ environment, registry });
  assert.deepEqual(report.rows.map(row => [row.model, row.chat, row.search]), [["sample/declared", true, null], ["sample/undeclared", true, null]]);
  assert.equal(report.exitCode, 0);
  assert.ok(report.rows.every(row => row.elapsedMs >= 0 && row.inputTokens === 7 && row.outputTokens === 2));
  for (const req of requests) {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.authorization, `Bearer ${environment.AGENT_GATEWAY_KEY}`);
    // 输入与 Codex 的格式一致（不是纯字符串）：网关会把字符串改写成简写格式，Kimi 收到简写格式时不搜索。
    assert.deepEqual(req.body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "只回复 OK" }] }]);
    assert.equal(req.body.tools, undefined);
    assert.ok(!JSON.stringify(req).includes(environment.SAMPLE_API_KEY));
  }
  const result = await run([], environment);
  assert.match(result.output, /模型.*对话.*联网搜索.*清单声明.*耗时.*用量/);
  assert.match(result.output, /未测/);
});

test("--model 只测一个模型，--search 检查调用标记并汇总用量，补声明提示不使检查失败", async t => {
  const { environment, requests } = await gateway(t);
  environment.AGENT_GATEWAY_URL = `http://127.0.0.1:${environment.AGENT_GATEWAY_PORT}/custom/v1/`;
  const report = await checkGateway({ environment, registry, model: "sample/undeclared", search: true });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(req => req.url === "/custom/v1/responses"));
  assert.ok(requests.every(req => req.body.model === "sample/undeclared"));
  assert.deepEqual(requests[1].body.tools, [{ type: "web_search", external_web_access: true }], "与 Codex 开启搜索时带的工具相同");
  assert.match(requests[1].body.input[0].content[0].text, /联网.*今天/);
  assert.deepEqual([report.rows[0].chat, report.rows[0].search, report.rows[0].inputTokens, report.rows[0].outputTokens], [true, true, 14, 4]);
  assert.equal(report.exitCode, 0);
  assert.match(report.messages.join("\n"), /实测支持 web_search，但清单未声明/);
  const result = await run(["--model", "sample/declared", "--search"], environment);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /sample\/declared \| 无 \| ✓ \| ✓ \| web_search/, "第二列是备用链");
  assert.doesNotMatch(result.output, /sample\/undeclared/);
});

test("仅声称已搜索不算成功；声明与实测不一致的提示及退出码", async t => {
  const { environment } = await gateway(t, () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "我已经联网搜索" }] }] }));
  const declared = await run(["--search", "--model", "sample/declared"], environment);
  assert.equal(declared.exitCode, 1);
  assert.match(declared.output, /✓ \| ✗ \| web_search/);
  assert.match(declared.output, /清单已声明 web_search，但实测失败/);
  assert.match(declared.output, /没有 web_search_call/);
  const undeclared = await run(["--search", "--model", "sample/undeclared"], environment);
  assert.equal(undeclared.exitCode, 0);
  assert.doesNotMatch(undeclared.output, /清单已声明/);
});

test("对话无文本、HTTP 错误、无效 JSON 和超时都失败，不打印上游正文或密钥", async t => {
  for (const [handler, reason, timeoutMs = 5000] of [
    [() => ({ output: [] }), /没有文本输出/],
    [() => ({ output: [{ type: "message", content: [{ type: "output_text", text: "  " }] }] }), /没有文本输出/],
    [() => ({ status: "failed", ...reply() }), /上游返回失败状态/],
    [(_body, res) => { res.statusCode = 401; return { error: "sk-bf-test-only provider-test-only" }; }, /HTTP 401/],
    [() => "无效 JSON sk-bf-test-only provider-test-only", /响应格式错误/],
    [() => undefined, /请求超时/, 100],
  ]) {
    const { environment } = await gateway(t, handler);
    const result = await run(["--model", "sample/declared"], environment, { timeoutMs });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /sample\/declared \| 无 \| ✗ \| 未测/);
    assert.doesNotMatch(result.output, /sk-bf-test-only|provider-test-only/);
    assert.match(result.output, /对话失败/);
    assert.match(result.output, reason);
  }
});

test("未启用网关、无可用模型和 CLI 参数错误给出中文说明", async () => {
  const disabled = await run([], {});
  assert.equal(disabled.exitCode, 1);
  assert.match(disabled.output, /没有启用模型网关.*npm run setup/);
  const empty = await run([], { AGENT_GATEWAY_KEY: "sk-bf-test-only" });
  assert.match(empty.output, /没有已启用服务商的对话模型/);
  for (const model of ["unknown/model", "inactive/chat", "sample/embedding"]) {
    const result = await run(["--model", model], { AGENT_GATEWAY_KEY: "sk-bf-test-only", SAMPLE_API_KEY: "test-only" });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /必须是清单中服务商已启用的对话模型/);
  }
  for (const args of [["--model"], ["--unknown"], ["--model", "--search"]]) {
    assert.match((await run(args, {})).output, /用法/);
  }
});

test("命令返回值成为进程退出码，声明的能力失败时为非零", async t => {
  const { environment } = await gateway(t, () => reply());
  // 注入测试环境和清单，子进程不读取项目 .env。
  const script = `import { main } from ${JSON.stringify(new URL("../scripts/gateway-check.mjs", import.meta.url).href)};
    process.exitCode = await main(process.argv.slice(1), { environment: ${JSON.stringify(environment)}, registry: ${JSON.stringify(registry)} });`;
  const exec = promisify(execFile);
  const success = await exec(process.execPath, ["--input-type=module", "-e", script]);
  assert.match(success.stdout, /未测/);
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", script, "--", "--search"]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /清单已声明 web_search，但实测失败/);
    return true;
  });
});
