import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./web-cli.mjs", import.meta.url));

export async function runWebCommand(name, args, signal, nodeEnv = process.env.NODE_ENV || "development") {
  const parameters = name === "read_webpage" ? ["read", args.url, String(args.max_chars ?? 16000)] : null;
  if (!parameters) throw new Error("未授权的网络命令。");
  let stdout;
  try {
    ({ stdout } = await exec(process.execPath, [script, ...parameters], {
      shell: false, cwd: fileURLToPath(new URL("./", import.meta.url)),
      env: { NODE_ENV: nodeEnv }, signal, timeout: 25000, killSignal: "SIGKILL", maxBuffer: 512 * 1024, encoding: "utf8"
    }));
  } catch (error) {
    signal?.throwIfAborted();
    if (error.killed || !error.stdout) throw new Error("网络工具超时或无法启动，未取得资料。");
    stdout = error.stdout;
  }
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error("网络工具返回格式错误，未取得资料。"); }
  if (!result.ok) throw new Error(result.error || "网络工具调用失败。");
  return result.data;
}

export function createTools({ runWeb = runWebCommand, nodeEnv = "development" }) {
  let webRunning = 0;
  async function read(args, { signal } = {}) {
    if (webRunning >= 2) throw new Error("已有两个网络任务执行中，请等待结果。");
    webRunning++;
    try { return await runWeb("read_webpage", args, signal, nodeEnv); }
    finally { webRunning--; }
  }
  return { read_webpage: read };
}
