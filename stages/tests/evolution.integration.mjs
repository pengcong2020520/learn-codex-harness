// 真 Codex + 本机模拟 Responses；只操作临时目录，不用真实 API Key。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable, PassThrough } from "node:stream";
import { runAppServer as runSingle, buildAppServerLaunch as singleLaunch } from "../s01-single-turn/05-app-server.mjs";
import { runAppServer as runChat, buildAppServerLaunch as chatLaunch } from "../s02-multi-turn/05-app-server.mjs";
import { tempRoot } from "../s03-agent-core/tests/helpers.mjs";
import { responsesFixture, answer, toolSpecs } from "../s03-agent-core/tests/responses-fixture.mjs";

async function fixture(t, stage, build) {
  const root = tempRoot(t);
  const provider = await responsesFixture(root, () => answer("合成回答：已接收。"));
  const require = createRequire(new URL(`../demo${stage}/package.json`, import.meta.url));
  const cli = path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin/codex.js");
  const launch = build({ CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: provider.url,
    CODEX_MODEL: "local-test-model", CODEX_MODEL_CATALOG_ENABLED: "true",
    CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "5000" });
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  return { root, provider, cli, launch, logs };
}
function io(text) {
  const output = new PassThrough(); output.resume();
  return { input: Readable.from([text]), output };
}
function calls(root) {
  return fs.readdirSync(path.join(root, ".runs")).flatMap(name =>
    fs.readFileSync(path.join(root, ".runs", name, "protocol.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse).filter(row => row.direction === "client").map(row => row.message));
}

test("demo1：真实 Codex 完成单轮并关闭，状态只写入独立 demo 根目录", { timeout: 15000 }, async t => {
  const r = await fixture(t, 1, singleLaunch);
  await runSingle(r.launch, { mode: "run", prompt: "SINGLE_DEMO_FIXTURE" }, r.cli, r.root);
  assert.equal(r.provider.requests.length, 1);
  assert.ok(r.logs.some(line => line.includes("模型回复： 合成回答")));
  assert.equal(calls(r.root).filter(call => call.method === "thread/start").length, 1);
  assert.equal(calls(r.root).filter(call => call.method === "turn/start").length, 1);
  assert.ok(fs.existsSync(path.join(r.root, ".data/codex/state_5.sqlite")));
  assert.ok(!toolSpecs(r.provider.requests[0]).some(tool => /shell|exec_command|apply_patch/.test(tool.name || "")));
  assert.deepEqual(r.provider.errors, []);
});

test("demo2：真实 Codex 同 Thread 多 turn，退出后搜索恢复仍携带原生上下文", { timeout: 15000 }, async t => {
  const r = await fixture(t, 2, chatLaunch);
  await runChat(r.launch, { mode: "chat" }, r.cli, r.root,
    io("BLUE_WHALE_FIXTURE\n追问本次会话代号\n/exit\n"));
  assert.equal(r.provider.requests.length, 2);
  assert.ok(JSON.stringify(r.provider.requests[1].input).includes("BLUE_WHALE_FIXTURE"));
  await runChat(r.launch, { mode: "chat" }, r.cli, r.root,
    io("/resume BLUE_WHALE_FIXTURE\n1\n恢复后追问\n/exit\n"));
  assert.equal(r.provider.requests.length, 3, r.logs.join("\n"));
  assert.ok(JSON.stringify(r.provider.requests[2].input).includes("BLUE_WHALE_FIXTURE"));
  const requests = calls(r.root);
  const turns = requests.filter(call => call.method === "turn/start");
  assert.equal(requests.filter(call => call.method === "thread/start").length, 1);
  assert.equal(requests.filter(call => call.method === "thread/resume").length, 1);
  assert.equal(new Set(turns.map(call => call.params.threadId)).size, 1);
  assert.deepEqual(r.provider.errors, []);
});
