// 进阶示例：不用 SDK，直接按 App Server 协议发送、接收 JSON 消息。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { newRun, reportError } from "../lib/common.mjs";
import { buildAppServerLaunch, createLogRedactor } from "../lib/app-server-config.mjs";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin/codex.js");
const redact = createLogRedactor(process.env.CODEX_API_KEY);
let launch;
try {
  launch = buildAppServerLaunch();
} catch (error) {
  reportError(new Error(redact(error.message)));
  process.exit(1);
}
const workspace = await newRun("app-server");
const eventFile = path.join(workspace, "protocol.jsonl");
console.log(launch.authMode === "apiKey"
  ? "认证方式：.env API Key（自定义 Responses 服务商）。"
  : "认证方式：复用已有 Codex 配置/登录（未配置 API Key）。");
const child = spawn(process.execPath, [cli, ...launch.args], {
  cwd: workspace, stdio: ["pipe", "pipe", "pipe"], env: launch.env,
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const errors = createInterface({ input: child.stderr, crlfDelay: Infinity });
errors.on("line", (line) => console.error(redact(line)));
const pending = new Map();
let sequence = 0;
let threadId;
let fatalError;
let closing = false;
let finishTurn;
let failTurn;
const completed = new Promise((resolve, reject) => { finishTurn = resolve; failTurn = reject; });
// 如果初始化先失败，避免尚未等待的 completed 产生未处理的 Promise 拒绝。
completed.catch(() => {});

function fail(error) {
  error = new Error(redact(error.message || String(error)));
  fatalError = error;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  failTurn(error);
}

function send(message) {
  appendFileSync(eventFile, redact({ direction: "client", message }) + "\n", { mode: 0o600 });
  child.stdin.write(JSON.stringify(message) + "\n");
}

function request(method, params) {
  if (fatalError) return Promise.reject(fatalError);
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    appendFileSync(eventFile, redact({ direction: "server", message }) + "\n", { mode: 0o600 });
    if (message.id !== undefined && message.method) {
      // 本练习不批准额外操作。完整产品需实现自己的授权交互。
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
        send({ id: message.id, result: { decision: "decline" } });
      } else {
        send({ id: message.id, error: { code: -32601, message: "Demo does not support this request" } });
      }
      return;
    }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "item/agentMessage/delta") process.stdout.write(redact(message.params.delta));
    if (message.method === "turn/completed" && message.params.threadId === threadId) {
      if (message.params.turn.status === "completed") finishTurn(message.params.turn);
      else fail(new Error(JSON.stringify(message.params.turn)));
    }
  } catch (error) {
    fail(error);
  }
});
child.on("error", fail);
child.stdin.on("error", fail);
child.on("close", (code) => {
  if (!closing) fail(new Error(`App Server 提前退出，退出码 ${code}`));
});
const timer = setTimeout(() => {
  fail(new Error("App Server 调用超时"));
  child.kill();
}, 180_000);
const cancel = () => { fail(new Error("用户取消")); child.kill(); };
process.once("SIGINT", cancel);

try {
  await request("initialize", {
    clientInfo: { name: "codex_harness_starter", title: "Harness Starter", version: "1.0.0" },
    capabilities: null,
  });
  send({ method: "initialized", params: {} });
  console.log("App Server 握手成功（本地连接正常，不代表 API Key 已通过验证）。");
  if (!process.argv.includes("--handshake-only")) {
    const result = await request("thread/start", {
      cwd: workspace,
      sandbox: "read-only",
      approvalPolicy: "never",
      ...(launch.model ? { model: launch.model } : {}),
    });
    threadId = result.thread.id;
    await request("turn/start", {
      threadId,
      input: [{ type: "text", text: "只回复：App Server 已连接。不要调用工具。", text_elements: [] }],
    });
    // turn/start 的响应仅代表任务被接受，还要等 turn/completed 才算结束。
    await completed;
    console.log("\n本轮完成。对话 ID：", threadId);
  }
  console.log("协议收发日志：", eventFile);
} catch (error) {
  reportError(new Error(redact(error.message)));
} finally {
  closing = true;
  clearTimeout(timer);
  process.removeListener("SIGINT", cancel);
  lines.close();
  errors.close();
  child.stdin.end();
  child.kill();
}
