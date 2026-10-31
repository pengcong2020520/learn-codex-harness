import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./web-cli.mjs", import.meta.url));

export async function runWebCommand(name, args, signal, nodeEnv = process.env.NODE_ENV || "development") {
  const parameters = name === "search_web" ? ["search", args.query, String(args.limit ?? 5)]
    : name === "read_webpage" ? ["read", args.url, String(args.max_chars ?? 16000)] : null;
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
  let nextSearchAt = 0, blockedUntil = 0, webRunning = 0;
  const cache = new Map();
  async function run(tool, args, { signal } = {}) {
    if (tool === "search_web") {
      const saved = cache.get(JSON.stringify(args));
      if (saved && saved.until > Date.now()) return saved.data;
      if (Date.now() < blockedUntil) throw new Error("Google 暂时不可用，已暂停自动重试 60 秒；请提供文章链接或稍后再试。");
      if (Date.now() < nextSearchAt) throw new Error("搜索过于频繁，请至少间隔 3 秒，不要并行搜索。");
      nextSearchAt = Date.now() + 3000;
    }
    if (webRunning >= 2) throw new Error("已有两个网络任务执行中，请等待结果。");
    webRunning++;
    let data;
    try { data = await runWeb(tool, args, signal, nodeEnv); }
    catch (error) { if (tool === "search_web" && !signal?.aborted) blockedUntil = Date.now() + 60000; throw error; }
    finally { webRunning--; }
    if (tool === "search_web") {
      if (cache.size >= 50) cache.delete(cache.keys().next().value);
      cache.set(JSON.stringify(args), { data, until: Date.now() + 600000 });
    }
    return data;
  }
  return { search_web: (args, context) => run("search_web", args, context), read_webpage: (args, context) => run("read_webpage", args, context) };
}
