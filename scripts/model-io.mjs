import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";
import { fail } from "./model-common.mjs";

// Windows 的 npm .cmd shim 不能直接 spawn，仍使用该阶段已安装的 CLI JS 入口，避免 shell 拼接。
function executable(command, args, platform = process.platform) {
  return platform === "win32" && path.basename(command) === "codex.cmd"
    ? [process.execPath, [path.resolve(path.dirname(command), "../@openai/codex/bin/codex.js"), ...args]]
    : [command, args];
}

// 所有输入（尤其 Key）均在 raw 模式读取；secret 时连占位星号也不回显。
export function askTerminal(prompt, { secret = false, input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") fail("交互配置需要终端；不从管道读取密钥。测试请注入 ask 函数。");
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const raw = Boolean(input.isRaw);
    emitKeypressEvents(input);
    const finish = (error) => {
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.removeListener("error", onEnd);
      input.setRawMode(raw);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new Error("input closed"));
    const onKey = (text, key = {}) => {
      if (key.ctrl && ["c", "d"].includes(key.name)) return onEnd();
      if (["return", "enter"].includes(key.name)) return finish();
      if (key.name === "backspace") {
        if (value) { value = [...value].slice(0, -1).join(""); if (!secret) output.write("\b \b"); }
      } else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) {
        value += text;
        if (!secret) output.write(text);
      }
    };
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.setRawMode(true);
    input.resume();
  });
}

// 包装进程 close 不代表原生子进程退出。终止操作独立等待整棵树，不能在 close 时取消强杀。
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return true;
    await delay(20);
  } while (Date.now() < deadline);
  return predicate();
}
function processTree(child, { platform, spawnImpl }) {
  let closed = false;
  const completion = new Promise(resolve => {
    child.once("error", () => { closed = true; resolve({ code: -1, failed: true }); });
    child.once("close", code => { closed = true; resolve({ code }); });
  });
  let stopping;
  const stop = () => stopping ||= (async () => {
    if (platform === "win32" && child.pid) {
      // taskkill 的完成才是树终止凭据；根包装先 close 也必须等它。
      const killed = await new Promise(resolve => {
        let killer;
        try { killer = spawnImpl("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); }
        catch { resolve(false); return; }
        const timer = setTimeout(() => { try { killer.kill(); } catch {} resolve(false); }, 3000);
        const finish = ok => { clearTimeout(timer); resolve(ok); };
        killer.once("error", () => finish(false));
        killer.once("close", code => finish(code === 0));
      });
      if (!killed) { try { child.kill("SIGKILL"); } catch {} return false; }
      return waitUntil(() => closed, 3000);
    }
    const signal = value => {
      try { if (child.pid) process.kill(-child.pid, value); else child.kill(value); }
      catch { /* 探测消失后才确认成功；权限等异常不能冒充已退出。 */ }
    };
    const gone = () => {
      if (!child.pid) return closed;
      try { process.kill(-child.pid, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    };
    signal("SIGTERM");
    if (!await waitUntil(gone, 500)) signal("SIGKILL");
    return waitUntil(() => gone() && closed, 3000);
  })();
  return { completion, stop };
}

// 子进程 stdout/stderr 只供内部结构化判定，调用方不得直接打印。
export async function runProcess(command, args, { cwd, env, timeoutMs = 15000, inherit = false, spawnImpl = spawn, platform = process.platform } = {}) {
  let child;
  try {
    child = spawnImpl(...executable(command, args, platform), {
      cwd, env, detached: platform !== "win32", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], windowsHide: !inherit,
    });
  } catch { return { code: -1, output: "", failed: true }; }
  const tree = processTree(child, { platform, spawnImpl });
  let output = "";
  const collect = chunk => { if (output.length < 256_000) output += chunk.toString().slice(0, 256_000 - output.length); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let timer;
  const result = await Promise.race([
    tree.completion,
    new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (!result.timedOut) return { ...result, output, timedOut: false };
  const stopped = await tree.stop();
  return { code: -1, output, timedOut: true, failed: !stopped, cleanupFailed: !stopped };
}

export async function loginStatus(cli, env, run = runProcess) {
  if (!cli) return { ok: false, text: "缺少 Codex 依赖" };
  const result = await run(cli, ["login", "status"], { env });
  if (result.failed) return { ok: false, text: "登录检查失败；未确认子进程正常结束" };
  if (result.timedOut) return { ok: false, text: "登录检查超时" };
  if (result.code === 0 && /Logged in using ChatGPT/i.test(result.output)) return { ok: true, text: "Logged in using ChatGPT" };
  if (result.code === 0 && /Logged in using.*API key/i.test(result.output)) return { ok: false, text: "本机为 API Key 登录；A 路线需要 ChatGPT 登录" };
  return { ok: false, text: "未登录、登录失效或检查失败；运行 npx codex login" };
}

export function handshake(cli, { cwd, env, timeoutMs = 15000, spawnImpl = spawn, platform = process.platform } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawnImpl(...executable(cli, ["app-server", "--listen", "stdio://"], platform), { cwd, env, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }); }
    catch { resolve(false); return; }
    const tree = processTree(child, { platform, spawnImpl });
    let buffer = "";
    let done = false;
    const finish = async ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 先发起树终止，再结束 stdin；Windows 要在包装退出前捕获其子树。
      const stopped = tree.stop();
      child.stdin.end();
      resolve(await stopped && ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    tree.completion.then(() => finish(false));
    child.stdin.on("error", () => finish(false));
    child.stderr.resume(); // 丢弃可能含密钥的诊断，不写日志。
    child.stdout.on("data", chunk => {
      if (done) return;
      buffer += chunk.toString();
      if (buffer.length > 256_000) return finish(false);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(false); }
        if (message.id === 1 && !message.method) {
          if (message.error || !message.result) return finish(false);
          child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n", () => finish(true));
          return;
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "setup_doctor", version: "1.0.0" }, capabilities: null } }) + "\n");
  });
}
