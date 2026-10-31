import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { finishRun } from "./runtime.mjs";

export class RpcError extends Error {
  constructor(error) {
    super(error.message || "Codex 请求失败");
    this.code = error.code;
    this.data = error.data;
  }
}

// 只负责进程和 JSON-RPC，不决定用户消息的执行顺序。
export class CodexConnection extends EventEmitter {
  constructor({ launch, runtime, redact, cli, log = console.error }) {
    super();
    this.launch = launch;
    this.runtime = runtime;
    this.redact = redact;
    this.log = log;
    this.cli = cli;
    this.pending = new Map();
    this.toolCalls = new Map();
    this.toolHandler = null;
    this.sequence = 0;
    this.closing = false;
    this.failure = null;
  }

  async open() {
    if (!this.cli) {
      const require = createRequire(import.meta.url);
      try { this.cli = path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin/codex.js"); }
      catch { throw new Error("缺少 Codex 依赖，请在 project 中运行 npm install。"); }
    }
    this.child = spawn(process.execPath, [this.cli, ...this.runtime.args], {
      cwd: this.runtime.workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.launch.env
    });
    this.exited = new Promise(resolve => this.child.once("close", (code, signal) => {
      if (!this.closing) this.fail(new Error(`Codex App Server 已退出：${code ?? signal}`));
      resolve();
    }));
    this.child.on("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.errors = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    this.errors.on("line", line => this.log(this.redact(line)));
    this.lines.on("line", line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(error); }
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "app_server_project", title: "Project Agent Server", version: "2.0.0" },
        capabilities: { experimentalApi: true }
      });
      this.send({ method: "initialized", params: {} });
    } catch (error) { await this.close(); throw error; }
  }

  record(direction, message) {
    appendFileSync(path.join(this.runtime.runDir, "protocol.jsonl"),
      this.redact({ direction, message }) + "\n", { mode: 0o600 });
  }

  send(message) {
    if (this.failure || this.closing) throw this.failure || new Error("Codex 连接已关闭。");
    this.record("client", message);
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params) {
    if (this.failure || this.closing) return Promise.reject(this.failure || new Error("Codex 连接已关闭。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Codex 请求超时：${method}；受理状态不确定，不能自动重发。`);
        error.uncertain = true;
        this.fail(error);
      }, this.launch.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { this.fail(error); }
    });
  }

  receive(message) {
    this.record("server", message);
    if (message.id !== undefined && message.method) {
      // 保留原案例的安全策略，不因架构拆分放宽工具权限。
      if (message.method === "item/tool/call" && this.toolHandler) {
        this.handleToolRequest(message);
      } else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
        this.send({ id: message.id, result: { decision: "decline" } });
      } else {
        this.send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
      }
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new RpcError(message.error));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "turn/completed") {
      for (const call of this.toolCalls.values()) {
        if (call.threadId === message.params?.threadId && call.turnId === message.params?.turn?.id) call.controller.abort();
      }
    }
    this.emit("notification", message);
  }

  handleToolRequest(message) {
    const params = message.params || {};
    const failure = text => ({ success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ error: text }) }] });
    const reply = result => {
      if (this.closing || this.failure) return;
      try { this.send({ id: message.id, result }); } catch (error) { this.fail(error); }
    };
    if ([params.threadId, params.turnId, params.callId].some(id => typeof id !== "string" || !id)) {
      reply(failure("工具调用缺少 Thread id、turn id 或 callId。")); return;
    }
    const key = JSON.stringify([params.threadId, params.turnId, params.callId]);
    const signature = JSON.stringify([params.namespace, params.tool, params.arguments]);
    let call = this.toolCalls.get(key);
    if (call && call.signature !== signature) { reply(failure("重复的工具调用 ID 携带了不同参数，已拒绝。")); return; }
    if (!call) {
      if (this.toolCalls.size >= 128) {
        for (const [id, old] of this.toolCalls) { if (old.done) { this.toolCalls.delete(id); break; } }
        if (this.toolCalls.size >= 128) { reply(failure("同时执行的工具调用过多。")); return; }
      }
      const controller = new AbortController();
      call = { threadId: params.threadId, turnId: params.turnId, signature, controller, done: false };
      // 请求回包仍按 JSON-RPC id 关联；执行按 callId 去重，不阻塞通知和其他 RPC 响应。
      call.promise = Promise.resolve().then(() => this.toolHandler(params, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      })).catch(error => failure(this.redact(error.message))).finally(() => { call.done = true; });
      this.toolCalls.set(key, call);
    }
    void call.promise.then(reply);
  }

  fail(error) {
    if (this.failure || this.closing) return;
    const safe = new Error(this.redact(error.message));
    safe.uncertain = true;
    this.failure = safe;
    for (const call of this.toolCalls.values()) call.controller.abort();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(safe);
    }
    this.pending.clear();
    this.emit("fatal", safe);
  }

  async close() {
    if (this.closing) return this.exited;
    this.closing = true;
    for (const call of this.toolCalls.values()) call.controller.abort();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("服务正在关闭，请求结果可能未确认。"));
    }
    this.pending.clear();
    if (!this.child) { finishRun(this.runtime.runDir); return; }
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), 1500);
    force.unref();
    await this.exited;
    clearTimeout(force);
    this.lines?.close();
    this.errors?.close();
    finishRun(this.runtime.runDir);
  }
}
