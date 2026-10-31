import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
console.log("Node.js：", process.version);
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("本练习统一使用 Node.js 24 或以上，包含内置 .env 加载功能。");
  process.exitCode = 1;
}
try {
  const manifestPath = require.resolve("@openai/codex/package.json");
  const cli = path.join(path.dirname(manifestPath), "bin", "codex.js");
  console.log("Codex SDK：", import.meta.resolve("@openai/codex-sdk"));
  for (const args of [["--version"], ["login", "status"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8", timeout: 15_000,
    });
    console.log((result.stdout || "").trim());
    console.log((result.stderr || "").trim());
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.log("如未登录，运行 npx codex login；API key 路线见 README.md。");
      process.exitCode = 1;
    }
  }
  console.log("此检查没有调用模型。账户能否实际运行，以 npm run hello 为准。");
} catch (error) {
  console.error("环境检查失败：", error.message);
  console.error("请先在项目目录运行 npm ci。");
  process.exitCode = 1;
}
