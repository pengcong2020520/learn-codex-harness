import { copyFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  root, runs, newRun, createCodex, threadOptions, streamTurn, reportError,
} from "../lib/common.mjs";

try {
  // 每次创建新的练习目录，所以可以反复复现“先失败、再修好”。
  const workspace = await newRun("repair");
  for (const file of ["add.mjs", "add.test.mjs"]) {
    await copyFile(path.join(root, "fixture", file), path.join(workspace, file));
  }
  const originalTest = await readFile(path.join(workspace, "add.test.mjs"), "utf8");
  const runTests = () => spawnSync(process.execPath, ["--test", "add.test.mjs"], {
    cwd: workspace, encoding: "utf8", timeout: 15_000,
  });
  const before = runTests();
  if (before.error || before.status !== 1) throw new Error("练习的初始测试没有按预期失败。");
  console.log("修复前：测试失败（这是故意安排的）。");
  console.log("练习目录：", workspace);

  const thread = createCodex().startThread(threadOptions(workspace, "workspace-write"));
  const eventFile = path.join(workspace, "events.jsonl");
  const prompt = [
    "这是一个最小代码调试练习。请先运行 node --test add.test.mjs 查看失败，",
    "然后读取 add.mjs 和 add.test.mjs，只修改 add.mjs 修复加法错误，",
    "最后再次运行 node --test add.test.mjs 确认通过。不要修改测试，不要安装依赖，",
    "不要联网、读取其他目录或使用与本练习无关的技能。最终用中文简短说明修改。",
  ].join("");
  await streamTurn(thread, prompt, eventFile);

  // 由我们的程序独立检查结果，不只相信 AI 说“修好了”。
  if (await readFile(path.join(workspace, "add.test.mjs"), "utf8") !== originalTest) {
    throw new Error("Codex 修改了测试文件，本次不算通过。");
  }
  const after = runTests();
  if (after.error || after.status !== 0) {
    throw new Error(`修复后测试仍未通过：\n${after.stdout}\n${after.stderr}`);
  }
  if (!thread.id) throw new Error("没有取得可恢复的对话 ID。");
  await writeFile(path.join(runs, "latest-repair.json"), JSON.stringify({
    threadId: thread.id, workspace, eventFile,
  }, null, 2) + "\n", { mode: 0o600 });
  console.log("\n验证通过：3 项测试全部成功，测试文件保持原样。");
  console.log("修复后的代码：\n" + await readFile(path.join(workspace, "add.mjs"), "utf8"));
  console.log("完整事件：", eventFile);
  console.log("下一步：npm run resume");
} catch (error) {
  reportError(error);
}
