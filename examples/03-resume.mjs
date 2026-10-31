import path from "node:path";
import { latestRepair, createCodex, threadOptions, streamTurn, reportError } from "../lib/common.mjs";

try {
  const { threadId, workspace } = await latestRepair();
  // 即使上一个 Node 程序已经退出，仍能凭 ID 继续已有对话。
  const thread = createCodex().resumeThread(threadId, threadOptions(workspace));
  const prompt = process.argv.slice(2).join(" ") ||
    "请根据我们上一轮对话，用一句中文说出刚才修改了哪个文件、修复了什么。不要调用工具。";
  await streamTurn(thread, prompt, path.join(workspace, `resume-${Date.now()}.jsonl`));
} catch (error) {
  reportError(error);
}
