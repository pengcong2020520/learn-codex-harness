import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadServerConfig, createLogRedactor } from "../server/modules/config/index.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { SessionService } from "../server/modules/sessions/index.mjs";

export const fixture = { CODEX_API_KEY: "test-key-not-real", CODEX_BASE_URL: "https://provider.invalid/v1", CODEX_MODEL: "unit-model", DEMO_TIMEOUT_MS: "3000" };
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
      return { turn: { id: turn.id, status: "inProgress", items: [] } };
    }
    if (method === "turn/interrupt") { this.finish(params.threadId, "interrupted"); return {}; }
    throw new Error(`未实现测试方法 ${method}`);
  }
}

export async function rig(t) {
  const root = tempRoot(t);
  const config = loadServerConfig(root, fixture);
  config.port = 0;
  const runtime = await prepareRun(config.launch, root);
  const rpc = new FakeRpc();
  const redact = createLogRedactor(fixture.CODEX_API_KEY);
  const sessions = new SessionService({ rpc, config, runtime, redact });
  const session = await sessions.create();
  cleanup(root, () => sessions.close());
  return { root, config, runtime, rpc, redact, sessions, session, cleanup: action => cleanup(root, action) };
}
