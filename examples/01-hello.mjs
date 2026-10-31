import { Codex } from "@openai/codex-sdk";

// SDK 会启动本机的 Codex 进程，默认复用 codex login 的登录状态。
const codex = new Codex({ apiKey: process.env.CODEX_API_KEY || undefined });

// thread 就是一段对话。这里先只聊天，因此不给文件写入权限。
const thread = codex.startThread({
  workingDirectory: process.cwd(),
  skipGitRepoCheck: true,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  webSearchMode: "disabled",
  model: process.env.CODEX_MODEL || undefined,
});

const prompt = process.argv.slice(2).join(" ") || "只回复：Codex harness 已连接。不要调用工具。";
console.log("正在连接 Codex，请等待……");

try {
  // 调试时在下一行左侧点一下，打上断点，再按 F5。
  const result = await thread.run(prompt, { signal: AbortSignal.timeout(180_000) });
  if (!result.finalResponse) throw new Error("本次没有收到最终回答，请检查登录、模型和网络。");
  console.log("回答：", result.finalResponse);
  console.log("对话 ID：", thread.id);
  console.log("用量：", result.usage);
} catch (error) {
  console.error("调用失败：", error.message);
  console.error("先运行 npm run doctor；其他排查步骤见 README.md。");
  process.exitCode = 1;
}
