import { Codex } from "@openai/codex-sdk";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, mkdtemp, appendFile, readFile } from "node:fs/promises";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const runs = path.join(root, ".runs");

export function createCodex() {
  return new Codex({ apiKey: process.env.CODEX_API_KEY || undefined });
}

export function threadOptions(workingDirectory, sandboxMode = "read-only") {
  return {
    workingDirectory,
    sandboxMode,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    webSearchMode: "disabled",
    networkAccessEnabled: false, // 限制写入沙箱中的命令联网；连接模型服务仍需要网络。
    model: process.env.CODEX_MODEL || undefined,
  };
}

export async function newRun(prefix) {
  await mkdir(runs, { recursive: true });
  return mkdtemp(path.join(runs, `${prefix}-`));
}

export async function latestRepair() {
  try {
    const state = JSON.parse(await readFile(path.join(runs, "latest-repair.json"), "utf8"));
    if (!state.threadId || !state.workspace) throw new Error("缺少对话 ID 或工作目录");
    return state;
  } catch (error) {
    throw new Error(`请先成功运行 npm run fix，再继续这段对话。${error.message}`);
  }
}

export async function withTimeout(work) {
  const milliseconds = Number(process.env.DEMO_TIMEOUT_MS || 180_000);
  if (!Number.isFinite(milliseconds) || milliseconds < 1) {
    throw new Error("DEMO_TIMEOUT_MS 必须是大于 0 的毫秒数");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("调用超时")), milliseconds);
  const cancel = () => controller.abort(new Error("用户按下 Ctrl+C"));
  process.once("SIGINT", cancel);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
  }
}

// 每个事件保留一行 JSON，方便对照 Codex 做过什么。
export async function streamTurn(thread, prompt, eventFile) {
  return withTimeout(async (signal) => {
    const { events } = await thread.runStreamed(prompt, { signal });
    let completed = false;
    let finalResponse = "";
    for await (const event of events) {
      await appendFile(eventFile, JSON.stringify(event) + "\n", { mode: 0o600 });
      if (event.type === "thread.started") console.log("对话 ID：", event.thread_id);
      if (event.type === "item.started" && event.item.type === "command_execution") {
        console.log("[执行命令]", event.item.command);
      }
      if (event.type === "item.completed") {
        const item = event.item;
        if (item.type === "agent_message") {
          finalResponse = item.text;
          console.log("[Codex]", item.text);
        } else if (item.type === "command_execution") {
          console.log(`[命令结果 exit=${item.exit_code}]`, item.aggregated_output);
        } else if (item.type === "file_change") {
          console.log("[文件变更]", item.status, item.changes);
        } else if (item.type === "error") {
          console.error("[工具错误]", item.message);
        }
      }
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") console.error("[连接事件]", event.message);
      if (event.type === "turn.completed") {
        completed = true;
        // 保留 CLI 返回的原始统计；0.154.0 恢复对话时会包含累计用量。
        console.log("[Codex 返回的用量统计]", event.usage);
      }
    }
    if (!completed) throw new Error("事件流已结束，但未收到 turn.completed；不能判定成功。");
    return finalResponse;
  });
}

export function reportError(error) {
  console.error("失败：", error.message);
  console.error("检查 npm run doctor 和 README.md；超时可在 .env 增大 DEMO_TIMEOUT_MS。");
  process.exitCode = 1;
}
