import { testDataFactory } from './jobs-fixture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgentServer } from "./authenticated-server.mjs";
import { AgentClient, loadClientConnection } from "../client/modules/connection/index.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { fixture, tempRoot, cleanup, until, installToolFixture } from "./helpers.mjs";

import { mock } from './mock-codex.mjs';

// The spawned CLI reads the same private credentials file that npm run login writes.
function writeClientCredentials(root, app) {
  mkdirSync(path.join(root, ".data"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(root, ".data/credentials.json"), JSON.stringify({ url: app.url, token: app.token }) + "\n", { mode: 0o600 });
}
async function appFixture(t, workflows) {
  const root = installToolFixture(tempRoot(t));
  if (workflows) {
    const file = path.join(root, "agents/writing/agent.json"), definition = JSON.parse(readFileSync(file));
    definition.agent.workflows = workflows; writeFileSync(file, JSON.stringify(definition));
  }
  const cli = path.join(root, "mock-codex.mjs");
  writeFileSync(cli, mock);
  const config = loadServerConfig(root, fixture); config.port = 0;
  const app = await startAgentServer({ dataFactory: testDataFactory, config, cli, log: () => {} });
  cleanup(root, () => app.close());
  const api = new AgentClient({ url: app.url, token: app.token });
  return { root, app, api };
}

test("真实本机 HTTP + stdio 假 Codex：提交非阻塞，断开客户端不取消任务", async t => {
  const { app, api } = await appFixture(t);
  const session = await api.request("/sessions", {});
  const events = [];
  const stream = api.subscribe(session.id, event => events.push(event));
  await until(() => events.some(event => event.type === "snapshot"));
  const first = await api.request("/messages", { threadId: session.id, clientMessageId: "a", text: "A" });
  assert.equal(first.status, "queued");
  await api.request("/messages", { threadId: session.id, clientMessageId: "b", text: "B" });
  stream.close(); await stream.done;
  await until(() => app.messages.job("b").status === "completed");
  const state = await api.request(`/state?threadId=${session.id}`);
  assert.equal(state.session.turns.length, 2);
  assert.notEqual(app.messages.job("a").turnId, app.messages.job("b").turnId);
  assert.equal((await api.request("/health")).status, "alive");
});

test("CLI 管道连续输入并 /exit，消息交给服务端后继续执行", async t => {
  const { root, app } = await appFixture(t);
  const clientFile = path.join(root, "client/main.mjs");
  writeClientCredentials(root, app);
  const child = spawn(process.execPath, [clientFile], { env: { ...process.env, AGENT_SERVER_URL: app.url }, stdio: ["pipe","pipe","pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once("close", resolve));
  child.stdin.end("first\nsecond\n/exit\n");
  const code = await exited;
  assert.equal(code, 0, output);
  assert.match(output, /已退出客户端/);
  assert.equal(app.messages.store.state.jobs.length, 2, output);
  await until(() => app.messages.store.state.jobs.every(job => job.status === "completed"));
  assert.ok(!output.includes(fixture.CODEX_API_KEY));
  assert.ok(!output.includes(app.token));
});

test("CLI 经真实 HTTP/SSE 接收多个流式片段，连续两轮的回复不换行拆碎", async t => {
  const { root, app } = await appFixture(t);
  const clientFile = path.join(root, "client/main.mjs");
  writeClientCredentials(root, app);
  const child = spawn(process.execPath, [clientFile], { env: { ...process.env, AGENT_SERVER_URL: app.url }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once("close", resolve));
  cleanup(root, async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  child.stdin.write("first\n");
  await until(() => output.includes("Agent：mock reply turn-1\n"));
  child.stdin.write("second\n");
  await until(() => output.includes("Agent：mock reply turn-2\n"));
  child.stdin.end("/exit\n");
  assert.equal(await exited, 0, output);
  // 每轮开始时显示这一轮用的模型和选择来源。
  assert.match(output, /模型：unit-model（默认路由）\nturn id: turn-1\nAgent：mock reply turn-1\n模型：unit-model（默认路由）\nturn id: turn-2\nAgent：mock reply turn-2\n/);
  assert.equal(output.split("Agent：").length - 1, 2);
  assert.equal(output.split("Thread id: thread-1").length - 1, 1);
  assert.doesNotMatch(output, /Agent \[|轮次 |消息已接收/);
  assert.ok(!output.includes(app.token));
});

test("认证令牌私有保存；拒绝未认证、跨源和错误 JSON 请求", async t => {
  const { root, app, api } = await appFixture(t);
  const file = path.join(root, ".data", "connection.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadClientConnection({}, root).url, app.url);
  assert.ok(!readFileSync(file, "utf8").includes(fixture.CODEX_API_KEY));
  assert.equal((await fetch(app.url + "/sessions")).status, 401);
  assert.equal((await fetch(app.url + "/sessions", { headers: { authorization: `Bearer ${app.token}`, origin: "https://untrusted.invalid" } })).status, 403);
  const bad = await fetch(app.url + "/messages", { method: "POST", headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" }, body: "null" });
  assert.equal(bad.status, 400);
  assert.equal((await api.request("/health")).version, "dev");
  await app.close();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(path.join(root, ".data", "server.lock")), false);
});

test("重复启动同项目会明确拒绝，不出现两个调度器", async t => {
  const { root, app } = await appFixture(t);
  await assert.rejects(startAgentServer({ dataFactory: testDataFactory, config: app.config, log: () => {} }), /已有 Agent 服务/);
});

test("工具状态接口只返回名称和状态，不泄露 MCP 令牌、模块路径或密钥", async t => {
  const { app, api } = await appFixture(t);
  const state = await api.request("/tools");
  assert.equal(state.status, "ready"); assert.equal(state.tools.length, 6);
  assert.ok(state.tools.some(tool => tool.name === "write_file"));
  const text = JSON.stringify(state);
  assert.ok(!text.includes(app.tools.token)); assert.ok(!text.includes(fixture.CODEX_API_KEY));
  assert.ok(!text.includes(".mjs"));
});

test("记忆 HTTP 管理复用认证和会话边界，不提供任意路径或清空接口", async t => {
  const { app, api } = await appFixture(t);
  assert.equal((await fetch(app.url + "/memory")).status, 401);
  assert.equal((await fetch(app.url + "/memory/summary", { headers: { authorization: `Bearer ${app.token}`, origin: "https://untrusted.invalid" } })).status, 403);
  const state = await api.request("/memory");
  assert.equal(state.effective.enabled, false);
  assert.equal(state.hasSummary, false);
  assert.equal((await api.request("/memory/summary")).text, "");
  assert.equal(app.sessions.sessions.size, 0);
  assert.ok(!JSON.stringify(state).includes(fixture.CODEX_API_KEY));
  const session = await api.request("/sessions", {});
  const result = await api.request("/memory/contribution", { threadId: session.id, enabled: false });
  assert.equal(result.mode, "disabled");
  await assert.rejects(api.request("/memory/contribution", { threadId: session.id, enabled: false, path: "../../.env" }), /只接受/);
  await assert.rejects(api.request("/memory/reset", {}), /不存在/);
  await assert.rejects(api.request("/memory/contribution", { threadId: "foreign", enabled: false }), /资源不存在/);
});

test("重连先同步快照，不把客户端再次连接当成新消息", async t => {
  const { app, api } = await appFixture(t);
  const session = await api.request("/sessions", {});
  await api.request("/messages", { threadId: session.id, clientMessageId: "only-once", text: "A" });
  await until(() => app.messages.job("only-once").status === "completed");
  const events = [];
  const subscription = api.subscribe(session.id, event => events.push(event));
  await until(() => events.length > 0);
  subscription.close(); await subscription.done;
  assert.equal(events[0].type, "snapshot");
  assert.equal(events[0].data.session.turns[0].status, "completed");
  assert.equal(app.messages.store.state.jobs.length, 1);
});


test("GET /tools 返回工具组默认 scope，保持原工具清单", async t => {
  const { api } = await appFixture(t), state = await api.request("/tools");
  assert.ok(state.groups.length > 0);
  assert.ok(state.groups.every(group => group.scope === "system" && group.id.endsWith(".json")));
  assert.deepEqual(state.groups.flatMap(group => group.tools).sort(), state.tools.map(tool => tool.name).sort());
});


test("真实 HTTP 修改当前步：重新执行、SSE 状态、再次等待、继续；跨用户与跨会话返回 404", async t => {
  const workflow = { id: "review", steps: [{ id: "draft", goal: "写初稿", confirm: true }, { id: "final", goal: "交付" }] };
  const { app, api } = await appFixture(t, [workflow]);
  const session = await api.request("/sessions", {}), other = await api.request("/sessions", {});
  const events = [], stream = api.subscribe(session.id, event => events.push(event));
  t.after(async () => { stream.close(); await stream.done; });
  await api.request("/messages", { threadId: session.id, clientMessageId: "revision", workflow: "review", text: "初稿" });
  await until(() => app.messages.job("revision").status === "waiting");
  const args = { threadId: session.id, taskId: "revision", text: "减少一层" };
  const reviseStatus = async (token, body) => (await fetch(app.url + "/tasks/revise", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  assert.equal(await reviseStatus(app.token, { ...args, threadId: other.id }), 404);
  const login = await api.request("/auth/login", { username: "bob", password: "fixture-password" });
  assert.equal(await reviseStatus(login.token, args), 404);
  assert.equal((await api.request("/tasks/revise", args)).step, 0);
  await until(() => app.messages.job("revision").status === "waiting" && app.messages.job("revision").reviseCount === 1);
  await until(() => events.some(event => event.type === "queue" && event.data.jobs.some(job => job.status === "waiting" && job.reviseCount === 1)));
  for (const status of ["queued", "running", "waiting"])
    assert.ok(events.some(event => event.type === "queue" && event.data.jobs.some(job => job.status === status && job.reviseCount === 1)), status);
  const state = await api.request(`/state?threadId=${session.id}`);
  assert.match(state.session.turns.at(-1).messages.map(message => message.text).join("\n"), /第 1 次按用户意见重做.*减少一层/);
  await api.request("/tasks/confirm", { threadId: session.id, taskId: "revision" });
  await until(() => app.messages.job("revision").status === "completed");
  assert.equal(app.messages.job("revision").step, 1);
  assert.equal(app.messages.job("revision").reviseCount, 0);
});
