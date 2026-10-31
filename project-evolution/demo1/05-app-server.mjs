// demo1：从当前 project 重建的单轮对话教学版，不依赖原项目。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment, buildModelCatalog, buildAppServerLaunch, createLogRedactor } from "./server/modules/config/index.mjs";
import { prepareRun, finishRun } from "./server/modules/codex/runtime.mjs";
import { AGENT_INSTRUCTIONS } from "./server/modules/role/index.mjs";

export const PROJECT_ROOT = fileURLToPath(new URL("./", import.meta.url));
const require = createRequire(import.meta.url);
const DEFAULT_PROMPT = "只回复：App Server 已连接。不要调用工具。";

// 复用本 demo 内的配置模块，角色与模型目录保持同一来源。
export { loadEnvironment, buildModelCatalog, buildAppServerLaunch, createLogRedactor };

export function parseOptions(argv) {
  if (argv.length === 0) return { mode: "run", prompt: DEFAULT_PROMPT };
  if (argv.length === 1 && ["--help", "--check", "--check-server", "--handshake-only"].includes(argv[0])) {
    return { mode: argv[0] === "--handshake-only" ? "check-server" : argv[0].slice(2) };
  }
  if (argv.length === 1 && !argv[0].startsWith("-") && argv[0].trim()) return { mode: "run", prompt: argv[0] };
  if (argv.length === 2 && argv[0] === "--prompt" && argv[1].trim()) return { mode: "run", prompt: argv[1] };
  throw new Error('参数不正确。使用 npm start -- "你的问题" 或 npm start -- --help。');
}

// ---------- 4. App Server：启动、握手、JSON-RPC 收发、单轮和循环聊天 ----------
// 每次启动生成自己的目录文件。--check 只校验内存中的配置，不写文件。
export { prepareRun };

export async function runAppServer(launch, options, cli, root = PROJECT_ROOT, io = {}) {
  // 每个 demo 拥有独立的 Codex 状态，不访问个人目录或其他版本。
  const home = path.join(root, ".data", "codex");
  for (const directory of [path.join(root, ".data"), home]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("状态目录必须是真实目录。");
  }
  launch = { ...launch, env: { ...launch.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home },
    args: [...launch.args, "-c", "features.memories=false", "-c", "features.shell_tool=false",
      "-c", "features.apply_patch_freeform=false", "-c", "agents.enabled=false", "-c", "tools.view_image=false", "-c", "features.apps=false"] };
  const redact = createLogRedactor(launch.env.CODEX_API_KEY);
  const { workspace, args, catalogFile } = await prepareRun(launch, root);
  if (catalogFile) console.log("已自动生成模型目录：", catalogFile);
  const eventFile = path.join(workspace, "protocol.jsonl");
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: workspace, stdio: ["pipe", "pipe", "pipe"], env: launch.env
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const errors = createInterface({ input: child.stderr, crlfDelay: Infinity });
  const pending = new Map();
  let sequence = 0;
  let threadId;
  let fatalError;
  let closing = false;
  let activeTurn = null;

  function fail(error) {
    if (closing || fatalError) return;
    fatalError = new Error(redact(error.message || String(error)));
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(fatalError); }
    pending.clear();
    activeTurn?.completed.reject(fatalError);
  }
  function record(direction, message) {
    appendFileSync(eventFile, redact({ direction, message }) + "\n", { mode: 0o600 });
  }
  function send(message) {
    record("client", message);
    child.stdin.write(JSON.stringify(message) + "\n");
  }
  function request(method, params) {
    if (fatalError) return Promise.reject(fatalError);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`App Server 请求超时：${method}`)), launch.timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { fail(error); }
    });
  }

  function handleTurnEvent(message) {
    const turn = activeTurn;
    if (!turn || message.params?.threadId !== turn.threadId) return;
    // turn/start 的通知可能早于 RPC 响应到达，先暂存，拿到 ID 后再严格匹配。
    if (!turn.id) { turn.buffer.push(message); return; }
    const eventTurnId = message.params.turnId || message.params.turn?.id;
    if (eventTurnId !== turn.id) return;
    if (message.method === "item/agentMessage/delta") {
      const id = message.params.itemId;
      turn.answers.set(id, (turn.answers.get(id) || "") + message.params.delta);
    }
    if (message.method === "item/completed" && message.params.item?.type === "agentMessage") {
      turn.answers.set(message.params.item.id, message.params.item.text);
    }
    if (message.method === "turn/completed") {
      if (message.params.turn.status === "completed") turn.completed.resolve(message.params.turn);
      else turn.completed.reject(new Error(redact(message.params.turn.error || { status: message.params.turn.status })));
    }
  }

  errors.on("line", line => console.error(redact(line)));
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      record("server", message);
      if (message.id !== undefined && message.method) {
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
          send({ id: message.id, result: { decision: "decline" } });
        } else {
          send({ id: message.id, error: { code: -32601, message: "This demo does not implement this request" } });
        }
        return;
      }
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(redact(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      handleTurnEvent(message);
    } catch (error) { fail(error); }
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  const exited = new Promise(resolve => child.once("close", (code, signal) => {
    if (!closing) fail(new Error(`App Server 提前退出：${code ?? signal}`));
    resolve();
  }));
  const cancel = () => fail(new Error("用户取消。"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  const threadOptions = {
    sandbox: "read-only", approvalPolicy: "never",
    baseInstructions: AGENT_INSTRUCTIONS,
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.authMode === "apiKey" ? { modelProvider: "project_api" } : {})
  };
  function selectThread(result) {
    threadId = result.thread.id;
    console.log("Thread id:", threadId);
    console.log("服务端选择的模型：", redact(result.model));
    console.log("服务端选择的服务商：", redact(result.modelProvider));
  }
  async function startThread() {
    selectThread(await request("thread/start", { ...threadOptions, cwd: workspace }));
  }
  async function runTurn(prompt) {
    if (!threadId) await startThread();
    const turn = { threadId, id: null, answers: new Map(), buffer: [], completed: Promise.withResolvers() };
    turn.completed.promise.catch(() => {});
    activeTurn = turn;
    const timer = setTimeout(() => fail(new Error("App Server 本轮调用超时；已停止连接，实际执行状态需检查日志，不自动重发。")), launch.timeoutMs);
    console.log("正在等待模型回复……");
    try {
      const result = await request("turn/start", {
        threadId, input: [{ type: "text", text: prompt, text_elements: [] }]
      });
      turn.id = result.turn.id;
      console.log("turn id:", turn.id);
      for (const message of turn.buffer) handleTurnEvent(message);
      turn.buffer = [];
      // RPC 响应仅表示受理；每一轮都必须等自己的 turn/completed。
      await turn.completed.promise;
      console.log("模型回复：", redact([...turn.answers.values()].join("\n")));
      console.log("本轮状态：completed；对话 ID：", threadId);
    } finally {
      clearTimeout(timer);
      activeTurn = null;
    }
  }

  try {
    await request("initialize", {
      clientInfo: { name: "app_server_project", title: "App Server Project", version: "1.0.0" },
      capabilities: null
    });
    send({ method: "initialized", params: {} });
    console.log("App Server 握手成功（不代表 API Key 已通过验证）。");

    if (options.mode === "check-server") {
      const listing = await request("model/list", {});
      console.log("App Server 已加载模型目录：", redact(listing.data.map(item => item.model).join(", ")));
      console.log("连接检查完成；没有发送 turn/start，没有发起模型生成。");
      return;
    }
    await runTurn(options.prompt);
  } finally {
    closing = true;
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    lines.close();
    errors.close();
    child.stdin.end();
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1500);
    force.unref();
    await exited;
    clearTimeout(force);
    finishRun(workspace);
    console.log("协议日志：", eventFile);
  }
}

// ---------- 5. 主入口：配置检查或执行；导入本文件做测试时不自动运行 ----------
export async function main(argv = process.argv.slice(2)) {
  let redact = createLogRedactor();
  try {
    const options = parseOptions(argv);
    if (options.mode === "help") {
      console.log("npm start -- \"你的问题\"  单轮问答\nnpm run check           检查本地配置\nnpm test                离线测试");
      return;
    }
    const environment = loadEnvironment();
    redact = createLogRedactor(environment.CODEX_API_KEY);
    const launch = buildAppServerLaunch(environment);
    let cli;
    try { cli = path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin/codex.js"); }
    catch { throw new Error("未安装 Codex 依赖。请在本 demo 目录运行 npm ci。"); }
    console.log("项目目录：", PROJECT_ROOT);
    console.log("配置来源：本 demo 的 .env（同名终端环境变量优先）");
    console.log("认证方式：", launch.authMode === "apiKey" ? "API Key（不显示密钥）" : "已有 Codex 配置/登录");
    console.log("配置模型：", redact(launch.model || "使用 Codex 默认值"));
    if (launch.baseUrl) console.log("API 地址：", redact(launch.baseUrl));
    console.log("模型目录来源：", launch.catalog ? ".env 参数（启动 App Server 时自动生成 JSON）" : "未启用自动生成，使用 Codex 默认目录来源");
    if (options.mode === "check") {
      console.log("本地基础配置检查通过；尚未验证完整 Codex 目录格式、API Key 或模型生成。");
      return;
    }
    await runAppServer(launch, options, cli);
  } catch (error) {
    console.error("失败：", redact(error.message));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
