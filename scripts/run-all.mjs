// 在仓库根目录统一安装依赖或运行离线测试。
// 各阶段与 app 仍是独立 npm 项目（各自锁定依赖、可单独复制），这里不用 npm workspaces，只按顺序逐个执行。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const packages = [
  "stages/s00-sdk-quickstart",
  "stages/s01-single-turn",
  "stages/s02-multi-turn",
  "stages/s03-agent-core",
  "stages/s04-data-layer",
  "stages/s05-knowledge-layer",
  "stages/s06-skill-workflow",
  "app",
];
// 只包含不调用真实模型、不依赖 PostgreSQL / Redis 的检查；集成验证见 stages/README.md。
const plans = {
  install: packages.map(dir => [dir, "npm", ["ci"]]),
  test: [
    ...packages.map(dir => [dir, "npm", ["test"]]),
    ["app", "npm", ["run", "test:web"]],
    ["app", "npm", ["run", "course:check"]],
    ["stages", process.execPath, ["verify.mjs", "--docs-only"]],
    [".", process.execPath, ["--test", "scripts/privacy-check.test.mjs"]],
    [".", process.execPath, ["scripts/privacy-check.mjs"]],
  ],
};

const plan = plans[process.argv[2]];
if (!plan) {
  console.error(`用法：node scripts/run-all.mjs <${Object.keys(plans).join("|")}>`);
  process.exit(2);
}
const failed = [];
for (const [dir, command, args] of plan) {
  const label = `${dir}: ${command === process.execPath ? "node" : command} ${args.join(" ")}`;
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, { cwd: path.join(root, dir), stdio: "inherit" });
  if (result.status !== 0) failed.push(label);
}
console.log(failed.length ? `\n✖ ${failed.length} 项失败：\n  ${failed.join("\n  ")}` : `\n✔ 全部 ${plan.length} 项通过`);
process.exitCode = failed.length ? 1 : 0;
