import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, cpSync, symlinkSync, rmSync as remove, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadServerConfig, createLogRedactor } from "../server/modules/config/index.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { SessionService } from "../server/modules/sessions/index.mjs";
import { MessageService } from "../server/modules/messages/index.mjs";
import { EventHub } from "../server/modules/events/index.mjs";
import { RpcError } from "../server/modules/codex/connection.mjs";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { TestJobs } from './jobs-fixture.mjs';
export { testDataFactory } from './jobs-fixture.mjs';

export const fixture = { CODEX_API_KEY: "test-key-not-real", CODEX_BASE_URL: "https://provider.invalid/v1", CODEX_MODEL: "unit-model", DEMO_TIMEOUT_MS: "3000" };
export function installToolFixture(root, { knowledge = false } = {}) {
  const project = fileURLToPath(new URL("../", import.meta.url));
  cpSync(path.join(project, "config/tools"), path.join(root, "config/tools"), { recursive: true });
  cpSync(path.join(project, "server/modules/tools"), path.join(root, "server/modules/tools"), { recursive: true });
  cpSync(path.join(project, "server/modules/data"), path.join(root, "server/modules/data"), { recursive: true });
  cpSync(path.join(project, "agents"), path.join(root, "agents"), { recursive: true });
  if (!knowledge) {
    remove(path.join(root, 'config/tools/knowledge.json'), { force: true });
    const file = path.join(root, 'agents/writing-agent.json');
    const definition = JSON.parse(readFileSync(file));
    definition.agent.tools.allow = definition.agent.tools.allow.filter(n => !n.startsWith('kb_'));
    delete definition.agent.knowledge; delete definition.bindings.knowledgeBases;
    definition.agent.skills = definition.agent.skills.filter(s => s.id !== 'knowledge');
    writeFileSync(file, JSON.stringify(definition));
  }
  symlinkSync(path.join(project, "node_modules"), path.join(root, "node_modules"), "dir");
  return root;
}
const cleanups = new Map();
export function cleanup(root, action) { cleanups.get(root).push(action); }
export function tempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-project-test-"));
  cleanups.set(root, []);
  t.after(async () => {
    try { for (const action of cleanups.get(root).reverse()) await action(); }
    finally { cleanups.delete(root); rmSync(root, { recursive: true, force: true }); }
  });
  return root;
}
export async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("等待测试条件超时。");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export class FakeRpc extends EventEmitter {
  constructor() { super(); this.calls = []; this.threads = new Map(); this.number = 0; this.mode = "normal"; }
  notify(method, params) { this.emit("notification", { method, params }); }
  finish(threadId, status = "completed") {
    const thread = this.threads.get(threadId);
    const turn = thread.turns.at(-1);
    if (!turn) throw new Error("没有活动轮次");
    turn.status = status;
    const text = `reply-${turn.id}`;
    const item = { type: "agentMessage", id: `answer-${turn.id}`, text };
    turn.items.push(item);
    this.notify("item/completed", { threadId, turnId: turn.id, item });
    this.notify("turn/completed", { threadId, turn: structuredClone(turn) });
  }
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "thread/memoryMode/set") return {};
    if (method === "thread/start") {
      const thread = { id: `thread-${this.threads.size + 1}`, cwd: params.cwd, turns: [] };
      this.threads.set(thread.id, thread);
      return { thread: structuredClone(thread), model: "unit-model", modelProvider: "project_api" };
    }
    if (method === "thread/list") return { data: [...this.threads.values()].map(thread => ({ ...thread, originator: "app_server_project" })), nextCursor: null };
    if (method === "thread/resume") return { thread: structuredClone(this.threads.get(params.threadId)), model: "unit-model", modelProvider: "project_api" };
    if (method === "turn/start") {
      const thread = this.threads.get(params.threadId);
      if (thread.turns.at(-1)?.status === "inProgress") throw new Error("测试发现同一个会话并发启动了两轮。");
      const turn = { id: `turn-${++this.number}`, status: "inProgress", items: [] };
      thread.turns.push(turn);
      this.notify("turn/started", { threadId: thread.id, turn: structuredClone(turn) });
      const item = { type: "userMessage", id: `user-${turn.id}`, clientId: params.clientUserMessageId, content: params.input };
      turn.items.push(item);
      this.notify("item/started", { threadId: thread.id, turnId: turn.id, item });
      if (this.mode === "early") this.finish(thread.id);
      if (this.mode === "uncertain-start") { const error = new Error("request uncertain"); error.uncertain = true; throw error; }
      return { turn: { id: turn.id, status: "inProgress", items: [] } };
    }
    if (method === "turn/steer") {
      const thread = this.threads.get(params.threadId);
      const turn = thread.turns.at(-1);
      if (this.mode === "end-before-steer") { this.finish(thread.id); throw new RpcError({ code: -32600, message: "no active turn to steer" }); }
      if (this.mode === "uncertain-steer") { const error = new Error("steer uncertain"); error.uncertain = true; throw error; }
      if (this.mode === "denied-steer") throw new RpcError({ code: -32600, message: "cannot steer a review turn" });
      if (turn?.status !== "inProgress") throw new RpcError({ code: -32600, message: "no active turn to steer" });
      if (turn.id !== params.expectedTurnId) throw new Error("追加到了错误的轮次。");
      const item = { type: "userMessage", id: `steer-${params.clientUserMessageId}`, clientId: params.clientUserMessageId, content: params.input };
      turn.items.push(item);
      this.notify("item/started", { threadId: thread.id, turnId: turn.id, item });
      return { turnId: turn.id };
    }
    if (method === "turn/interrupt") { this.finish(params.threadId, "interrupted"); return {}; }
    throw new Error(`未实现测试方法 ${method}`);
  }
}

export async function rig(t) {
  const root = installToolFixture(tempRoot(t));
  const config = loadServerConfig(root, fixture);
  config.port = 0;
  const runtime = await prepareRun(config.launch, root);
  const agent = new AgentDefinition(root); agent.configure(config, runtime); agent.activate("unit-tools");
  const rpc = new FakeRpc();
  const hub = new EventHub();
  const redact = createLogRedactor(fixture.CODEX_API_KEY);
  const sessions = new SessionService({ rpc, config, runtime, hub, redact });
  const messages = await new MessageService({ rpc, config, sessions, hub, store: new TestJobs() }).open();
  const session = await sessions.create();
  // 明确在临时目录移除之前释放持久化对象。
  const close = async () => { await messages.close(); sessions.close(); };
  cleanup(root, close);
  return { root, config, runtime, rpc, hub, redact, sessions, messages, session, close, cleanup: action => cleanup(root, action),
    submit(text, id, mode = "enqueue", targetTurnId = null, threadId = session.id) {
      return messages.submit({ threadId, text, clientMessageId: id, mode, targetTurnId });
    } };
}
