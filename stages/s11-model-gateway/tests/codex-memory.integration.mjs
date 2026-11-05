import { testDataFactory } from './jobs-fixture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startAgentServer } from "../server/main.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { tempRoot, installToolFixture, cleanup, until } from "./helpers.mjs";
import { responsesFixture, answer, toolSpecs } from "./responses-fixture.mjs";

function memoryPolicy(root, contribute) {
  const file = path.join(root, "agents/writing/agent.json"), value = JSON.parse(fs.readFileSync(file));
  value.agent.memory = { use: true, contribute }; fs.writeFileSync(file, JSON.stringify(value));
}

test("真实 Codex：原生提炼、参与设置持久化，以及禁用写工具时的合并限制", { timeout: 30000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  memoryPolicy(root, true);
  const logs = [];
  let phase1 = 0, phase2 = 0;
  let mergeTools;
  const provider = await responsesFixture(root, body => {
    if (body.model === "memory-extract-test") {
      phase1++;
      assert.ok(!JSON.stringify(body.input).includes("EXCLUDED_MEMORY_FIXTURE"), "禁用的源会话不得进入提炼");
      assert.equal(body.text.format.type, "json_schema");
      assert.equal(body.text.format.strict, true);
      return answer(JSON.stringify({ rollout_summary: "合成测试：用户喜欢以具体案例开头。", rollout_slug: "writing-preference", raw_memory: "用户喜欢以具体案例开头。" }));
    }
    if (body.model === "memory-merge-test") {
      phase2++;
      mergeTools = toolSpecs(body).map(tool => tool.name);
    }
    return answer("这是合成测试回复，记录了用户的写作偏好。");
  });
  const config = loadServerConfig(root, {
    CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: provider.url, CODEX_MODEL: "local-test-model",
    CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "5000",
    AGENT_MEMORY_ENABLED: "true", AGENT_MEMORY_MIN_IDLE_HOURS: "1",
    AGENT_MEMORY_EXTRACT_MODEL: "memory-extract-test", AGENT_MEMORY_CONSOLIDATION_MODEL: "memory-merge-test"
  });
  config.port = 0;
  let app;
  cleanup(root, () => app?.close());
  app = await startAgentServer({ dataFactory: testDataFactory, config, log: line => logs.push(line) });
  assert.equal(app.memory.snapshot().effective.enabled, true);
  assert.equal(app.memory.snapshot().generationCapability, "blocked");
  const session = await app.sessions.create();
  await app.messages.submit({ threadId: session.id, clientMessageId: "seed", text: "我是测试用户，我的文章偏好是先用具体案例开头。".repeat(80) });
  await until(() => app.messages.job("seed")?.status === "completed", 10000);
  const excluded = await app.sessions.create();
  await app.messages.submit({ threadId: excluded.id, clientMessageId: "excluded", text: "EXCLUDED_MEMORY_FIXTURE：不参与提炼的合成会话。".repeat(80) });
  await until(() => app.messages.job("excluded")?.status === "completed", 10000);
  await app.memory.contribute(excluded.id, false);
  await app.close();
  const home = path.join(root, ".data/codex");
  const state = new DatabaseSync(path.join(home, "state_5.sqlite"));
  try {
    assert.equal(state.prepare("SELECT memory_mode FROM threads WHERE id = ?").get(excluded.id).memory_mode, "disabled");
    // 只老化本测试临时库中的合成会话，不改用户的任何真实历史。
    state.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(Math.floor(Date.now()/1000)-14400, Math.floor(Date.now()/1000)-7200, session.id);
    state.prepare("UPDATE threads SET created_at = ?, updated_at = ? WHERE id = ?").run(Math.floor(Date.now()/1000)-14400, Math.floor(Date.now()/1000)-7200, excluded.id);
  } finally { state.close(); }
  app = await startAgentServer({ dataFactory: testDataFactory, config, log: line => logs.push(line) });
  const trigger = await app.sessions.create();
  await app.messages.submit({ threadId: trigger.id, clientMessageId: "trigger", text: "你好，这是触发记忆检查的合成测试。" });
  await until(() => phase2 > 0, 12000).catch(error => { throw new Error(`${error.message}；提炼=${phase1} 合并=${phase2}；${logs.join("\n")}`); });
  assert.equal(phase1, 1, "必须实际提炼一次；被禁用的源会话不得参与");
  assert.ok(!mergeTools.some(name => /shell|exec_command|apply_patch|write_file/.test(name)), "不得偷偷放开后台写权限");
  assert.match(fs.readFileSync(path.join(home, "memories/raw_memories.md"), "utf8"), /具体案例/);
  assert.equal(app.memory.snapshot().hasSummary, false, "原始提炼产物不是可供注入的最终摘要");
  assert.equal(app.memory.snapshot().artifacts["raw_memories.md"].exists, true);
  assert.deepEqual(provider.errors, []);
});

test("真实 Codex：预置合成摘要在新 Thread 自动注入，读取关闭后不注入，重启不删除产物", { timeout: 30000 }, async t => {
  const root = installToolFixture(tempRoot(t));
  memoryPolicy(root, false);
  const marker = "MEMORY_FIXTURE_CASE_OPENING_7Q9";
  const provider = await responsesFixture(root, () => answer("合成回答"));
  const env = {
    CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: provider.url, CODEX_MODEL: "local-test-model",
    CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "5000",
    AGENT_MEMORY_ENABLED: "true", AGENT_MEMORY_GENERATE: "false"
  };
  let app;
  cleanup(root, () => app?.close());
  async function start(extra = {}) {
    const config = loadServerConfig(root, { ...env, ...extra }); config.port = 0;
    return startAgentServer({ dataFactory: testDataFactory, config, log: () => {} });
  }
  app = await start();
  const directory = path.join(root, ".data/codex/memories");
  fs.mkdirSync(directory, { recursive: true });
  // 明确预置测试夹具：本用例验证读取，不冒充自动生成已跑通。
  fs.writeFileSync(path.join(directory, "memory_summary.md"), `## User Profile\n${marker}: 文章用具体案例开头。\n`);
  async function turn(id) {
    const thread = await app.sessions.create();
    await app.messages.submit({ threadId: thread.id, clientMessageId: id, text: "介绍一下写作方法。" });
    await until(() => app.messages.job(id)?.status === "completed", 10000);
    return thread;
  }
  const first = await turn("read");
  assert.ok(JSON.stringify(provider.requests.at(-1)).includes(marker), "新 Thread 的模型请求必须携带原生注入的摘要");
  assert.ok(!toolSpecs(provider.requests.at(-1)).some(tool => /shell_command|exec_command|apply_patch/.test(tool.name || "")));
  assert.equal(app.memory.summary().text.includes(marker), true);
  await app.memory.contribute(first.id, false);
  await app.close();
  app = await start({ AGENT_MEMORY_USE: "false" });
  assert.equal(app.memory.snapshot().effective.use, false);
  assert.equal(app.memory.snapshot().hasSummary, true, "关闭读取不等于删除记忆");
  await turn("no-read");
  assert.ok(!JSON.stringify(provider.requests.at(-1)).includes(marker), "关闭读取后新 Thread 不应注入原生摘要");
  const state = new DatabaseSync(path.join(root, ".data/codex/state_5.sqlite"), { readOnly: true });
  try { assert.equal(state.prepare("SELECT memory_mode FROM threads WHERE id = ?").get(first.id).memory_mode, "disabled"); }
  finally { state.close(); }
  assert.deepEqual(provider.errors, []);
});
