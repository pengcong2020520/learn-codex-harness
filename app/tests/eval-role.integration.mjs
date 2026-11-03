// 角色评估运行器：真 Codex 0.154.0 + 本机模拟 Responses，不读取 .env，不调用真实模型。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { testDataFactory } from "./jobs-fixture.mjs";
import { tempRoot } from "./helpers.mjs";
import { responsesFixture, answer, toolCall, toolSpecs } from "./responses-fixture.mjs";
import { loadScenarios, runOnce } from "../scripts/eval-role.mjs";
import { runChecks } from "../scripts/eval/checks.mjs";

const app = path.resolve(import.meta.dirname, "..");

test("评估运行器：独立临时项目里跑一个场景，记录 token、工具调用、回复与产出，结束后清理", { timeout: 90000 }, async t => {
  const work = tempRoot(t), out = path.join(work, "out");
  // 内存数据层没有权限门禁与知识库服务，测试用的 Agent 包去掉知识库相关配置。
  const agentDir = path.join(work, "agent");
  fs.cpSync(path.join(app, "agents/writing"), agentDir, { recursive: true });
  const definition = JSON.parse(fs.readFileSync(path.join(agentDir, "agent.json"), "utf8"));
  definition.agent.tools.allow = definition.agent.tools.allow.filter(name => !name.startsWith("kb_"));
  definition.agent.skills = definition.agent.skills.filter(skill => skill.id !== "knowledge");
  definition.agent.workflows = definition.agent.workflows.filter(workflow => workflow.id !== "knowledge-maintain");
  delete definition.agent.knowledge; delete definition.bindings.knowledgeBases; delete definition.bindings.skills.knowledge;
  fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify(definition));

  let step = 0;
  const provider = await responsesFixture(work, body => {
    const specs = toolSpecs(body);
    const plan = [
      ["read_file", { path: "inputs/report/Q3数据.md" }],
      ["write_file", { path: "outputs/q3-report.md", content: "# Q3 汇报\n\n结论：解决率 63%，未达 65% 目标。\n\n## 成果\n满意度 4.4。" }],
    ];
    const action = plan[step++];
    if (!action) return answer("汇报已保存到 outputs/q3-report.md。");
    return toolCall(specs.find(spec => spec.name?.endsWith(action[0])), action[1]);
  });
  const env = { ...process.env, CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: provider.url, CODEX_MODEL: "local-test-model",
    CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "15000" };
  const scenario = loadScenarios(["s4-report"])[0];
  const before = new Set(fs.readdirSync(path.dirname(work)));

  const record = await runOnce({ label: "current", agentDir, scenario, index: 1, env, out, timeoutMs: 60000, dataFactory: testDataFactory });
  assert.deepEqual(provider.errors, []);
  assert.equal(record.status, "completed", record.error);
  assert.equal(record.reply, "汇报已保存到 outputs/q3-report.md。");
  assert.equal(record.usage.requests, 3);
  assert.equal(record.usage.total.inputTokens, 3000);
  assert.equal(record.usage.total.outputTokens, 900);
  assert.deepEqual(record.tools.map(tool => [tool.tool, tool.args?.path]), [["read_file", "inputs/report/Q3数据.md"], ["write_file", "outputs/q3-report.md"]]);
  assert.ok(record.instructionsChars > 1000 && record.skills.includes("write-article"));
  assert.deepEqual(record.files.map(file => file.path), ["outputs/q3-report.md"], "只收集模型写出的文件，不含输入资料");
  assert.ok(!JSON.stringify(provider.requests[0]).includes("按每次转人工平均处理 6 分钟估算"), "场景资料只放进工作区，由模型自己读取");
  assert.ok(JSON.stringify(provider.requests[0]).includes("客服智能助手"), "场景要求作为用户消息发出");

  const saved = JSON.parse(fs.readFileSync(path.join(out, "current/s4-report/run-1.json"), "utf8"));
  assert.equal(saved.status, "completed");
  const checks = Object.fromEntries(runChecks(scenario, { files: saved.files, reply: saved.reply }).map(item => [item.id, item.pass]));
  assert.equal(checks.deliverable, true);
  assert.equal(checks["rate-gap"], true);
  assert.equal(checks["key-metrics"], false);
  const leftover = fs.readdirSync(path.dirname(work)).filter(name => name.startsWith("eval-role-") && !before.has(name));
  assert.deepEqual(leftover, [], "临时项目目录应已删除");
});

test("评估运行器 --capture：透传代理不改变结果，并记录每次请求的组成", { timeout: 90000 }, async t => {
  const work = tempRoot(t), out = path.join(work, "out");
  const agentDir = path.join(work, "agent");
  fs.cpSync(path.join(app, "agents/writing"), agentDir, { recursive: true });
  const definition = JSON.parse(fs.readFileSync(path.join(agentDir, "agent.json"), "utf8"));
  definition.agent.tools.allow = ["list_files", "read_file", "write_file"];
  definition.agent.skills = []; definition.agent.workflows = []; definition.bindings.skills = {};
  delete definition.agent.knowledge; delete definition.bindings.knowledgeBases;
  fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify(definition));
  let step = 0;
  const provider = await responsesFixture(work, body => step++ ? answer("完成。") : toolCall(toolSpecs(body).find(spec => spec.name?.endsWith("list_files")), {}));
  const env = { ...process.env, CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: provider.url, CODEX_MODEL: "local-test-model",
    CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "15000" };
  const record = await runOnce({ label: "current", agentDir, scenario: loadScenarios(["s2-wechat"])[0], index: 1, env, out, timeoutMs: 60000,
    dataFactory: testDataFactory, capture: true });
  assert.equal(record.status, "completed", record.error);
  assert.equal(record.reply, "完成。");
  assert.equal(provider.requests.length, 2, "请求经代理原样到达模型服务");
  assert.equal(record.requestParts.length, 2);
  const [first, second] = record.requestParts;
  assert.ok(first.instructions > 1000, "基础指令里是角色内容");
  assert.ok(first.tools > 100);
  assert.ok(first["message:user"] > 100, "用户消息含场景要求");
  assert.ok(second.function_call_output > 0, "第二次请求带上工具结果");
  const saved = JSON.parse(fs.readFileSync(path.join(out, "current/s2-wechat/run-1.requests.json"), "utf8"));
  assert.equal(saved[0].instructions, provider.requests[0].instructions);
});
