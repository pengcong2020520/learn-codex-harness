// Opt-in real model acceptance. Only synthetic inputs and isolated DB/workspace are used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PROJECT_ROOT } from "../shared/paths.mjs";
import {
  loadEnvironment,
  loadServerConfig,
  createLogRedactor,
} from "../server/modules/config/index.mjs";
import { startAgentServer } from "../server/main.mjs";
import { openDatabase, migrate } from "../server/modules/data/database.mjs";
import { AgentClient } from "../client/modules/connection/index.mjs";
import { installToolFixture } from "../tests/helpers.mjs";
if (!process.env.DATA_TEST_DATABASE_URL || !process.env.DATA_TEST_REDIS_URL)
  throw new Error("请用 npm run smoke:real 启动隔离依赖。");
const credentials = loadEnvironment(PROJECT_ROOT),
  redact = createLogRedactor(credentials.CODEX_API_KEY);
const report = {
  date: new Date().toISOString(),
  model: credentials.CODEX_MODEL,
  engine: "0.154.0",
  realModel: true,
  isolated: true,
  examples: [],
};
const pool = await openDatabase(process.env.DATA_TEST_DATABASE_URL);
await migrate(pool);
await pool.end();
let failure;
for (const example of ["writing", "customer-support"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-real-smoke-"));
  let app;
  const item = { example, passed: false, checks: [], calls: [] };
  report.examples.push(item);
  try {
    installToolFixture(root, { knowledge: true });
    fs.cpSync(
      path.join(PROJECT_ROOT, "examples", example),
      path.join(root, "example"),
      { recursive: true },
    );
    const definition = JSON.parse(
        fs.readFileSync(path.join(root, "example/agent/agent.json")),
      ),
      kb = definition.agent.knowledge[0].kbId;
    const binding = definition.bindings.knowledgeBases[kb],
      workspace = path.join(root, "example/workspace");
    for (const dir of [
      binding.sourceRoot,
      binding.wikiRoot,
      ...Object.values(definition.bindings.sources).map((s) => s.root),
      definition.agent.outputs.directory,
    ])
      fs.mkdirSync(path.join(workspace, dir), { recursive: true });
    const marker = "SMOKE_" + randomUUID(),
      input = `${binding.sourceRoot}/smoke-source.md`,
      output = `${definition.agent.outputs.directory}/smoke-result.md`;
    fs.writeFileSync(
      path.join(workspace, input),
      `# 验收资料\n验证码：${marker}\n虚构规则：客服只承诺人工审核，不承诺退款已经到账。\n`,
    );
    const config = loadServerConfig(root, {
      ...credentials,
      AGENT_DEFINITION: "example/agent/agent.json",
      AGENT_MEMORY_ENABLED: "false",
      DATABASE_URL: process.env.DATA_TEST_DATABASE_URL,
      REDIS_URL: process.env.DATA_TEST_REDIS_URL,
      AGENT_TURN_TIMEOUT_MS: "180000",
      DEMO_TIMEOUT_MS: "30000",
    });
    config.port = 0;
    async function start() {
      app = await startAgentServer({ config, log: () => {} });
      const handler = app.rpc.toolHandler;
      app.rpc.toolHandler = (params, context) => {
        const trusted = app.gate.forTurn(params.threadId, params.turnId);
        item.calls.push({
          tool: params.tool,
          userId: trusted.userId,
          threadId: trusted.threadId,
          turnId: trusted.turnId,
        });
        return handler(params, context);
      };
      return new AgentClient({ url: app.url, token: app.token });
    }
    let api = await start();
    item.checks.push("config + real PG/Redis + Codex readiness");
    const session = await api.request("/sessions", {});
    item.threadId = session.id;
    async function turn(text, knowledge) {
      const id = randomUUID();
      await api.request("/messages", {
        threadId: session.id,
        clientMessageId: id,
        text,
        ...(knowledge ? { knowledge } : {}),
      });
      const deadline = Date.now() + 180000;
      let state, job;
      do {
        state = await api.request(`/state?threadId=${session.id}`);
        job = state.queue.jobs.find((j) => j.id === id);
        if (["failed", "interrupted", "unconfirmed"].includes(job?.status))
          throw new Error(`任务 ${job.status}: ${job.error || ""}`);
        if (job?.status === "completed")
          return {
            job,
            turn: state.session.turns.find((t) => t.id === job.turnId),
          };
        await new Promise((r) => setTimeout(r, 250));
      } while (Date.now() < deadline);
      throw new Error("真实模型任务超过180秒；未重发。");
    }
    const first = await turn(
      `这是技术冒烟验收，不是文章写作。请调用 read_file 读取 ${input}，再调用 write_file 新建 ${output}。正文写一个 Markdown 标题并逐字包含资料中的验证码。必须用读到的 resourceId/versionId 填写 source_versions。不要调用网页工具，不要只口头声称保存。完成后简短回复。`,
    );
    assert.ok(
      fs.readFileSync(path.join(workspace, output), "utf8").includes(marker),
    );
    assert.ok(Object.keys(first.turn.artifacts).length > 0);
    item.checks.push("real model read → write → PG artifact provenance");
    item.turnIds = [first.job.turnId];
    const descriptor = app.agent.descriptor.hash;
    await app.close();
    // A release containing only implementation annotations must preserve the native Thread.
    fs.appendFileSync(
      path.join(root, "server/modules/tools/files.mjs"),
      "\n// real smoke: implementation annotation only\n",
    );
    api = await start();
    assert.equal(app.agent.descriptor.hash, descriptor);
    await api.request("/sessions/resume", { threadId: session.id });
    const second = await turn(
      `继续之前的验收。请调用 read_file 读取上一轮保存的 ${output}，回复完整验证码。`,
    );
    assert.ok(Object.values(second.turn.answers).join("\n").includes(marker));
    assert.notEqual(second.job.turnId, first.job.turnId);
    item.turnIds.push(second.job.turnId);
    item.checks.push(
      "implementation comment → restart → resume same Thread → new Turn with verified answer",
    );
    const third = await turn(
      `请维护知识库 ${kb}。调用 read_file 读取 ${input}，然后用 kb_submit_revision 新建 slug 为 smoke-check 的页面（expectedVersion 为 null），内容必须有 Markdown 标题并包含该资料的完整验证码，source_versions 填真实 resourceId/versionId。不使用 write_file 写 Wiki。`,
      { kbId: kb, operation: "update" },
    );
    const page = await api.request(
      `/knowledge/read?kbId=${kb}&slug=smoke-check`,
    );
    assert.ok(page.content.includes(marker));
    assert.ok(page.source_versions.length);
    item.turnIds.push(third.job.turnId);
    item.checks.push(
      "scoped maintenance → real Wiki submission → authorized read",
    );
    await assert.rejects(
      api.request("/messages", {
        threadId: session.id,
        clientMessageId: randomUUID(),
        text: "no execution",
        userId: "forged",
      }),
    );
    item.checks.push("client identity spoof rejected");
    assert.ok(
      item.calls.length >= 4 &&
        item.calls.every(
          (c) => c.userId && c.threadId === session.id && c.turnId,
        ),
    );
    item.checks.push("every tool call carries trusted user/thread/turn");
    item.artifactHash = createHash("sha256")
      .update(fs.readFileSync(path.join(workspace, output)))
      .digest("hex");
    item.passed = true;
    console.log(
      `${example}: PASS (${item.checks.length} checks, ${item.calls.length} real tool calls)`,
    );
  } catch (error) {
    item.error = redact(error.message);
    item.diagnosticRoot = root;
    failure = error;
    console.error(`${example}: FAIL ${item.error}`);
  } finally {
    await app?.close();
    if (item.passed) fs.rmSync(root, { recursive: true, force: true });
  }
  if (failure) break;
}
const reportDir = path.join(PROJECT_ROOT, "docs/verification");
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  path.join(reportDir, "real-model-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
if (failure) process.exitCode = 1;
