// 不读取 .env、不调用真实模型；完整验证后更新根目录的验收记录。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("./", import.meta.url));
const options = new Set(process.argv.slice(2));
if ([...options].some(option => !["--integration", "--docs-only", "--rag"].includes(option))) {
  throw new Error("用法：node verify.mjs [--integration [--rag] | --docs-only]");
}
const report = { verifiedAt: new Date().toISOString(), modelProvider: "local simulated Responses", embeddingProvider: options.has("--rag") ? "local deterministic 3D fixture" : null, semanticQualityVerified: false, docs: [], checks: [] };
for (const name of ["README.md", ...[1, 2, 3, 4, 5].map(n => `demo${n}/README.md`), "demo4/docs/data-layer.md", "demo3/docs/tools.md", "demo5/docs/knowledge-implementation.md"]) {
  const file = path.join(root, name), doc = fs.readFileSync(file, "utf8");
  if (name !== "README.md" && !name.endsWith("knowledge-implementation.md")) {
    for (const heading of ["设计原理", "架构改进", "技术实现流程", "核心代码"]) {
      assert.ok(doc.includes(`## ${heading}\n`), `${name} 缺少 ${heading}`);
    }
    assert.ok(doc.includes("伪代码"), `${name} 未标明伪代码`);
  }
  assert.equal((doc.match(/^```/gm) || []).length % 2, 0, `${name} 代码块未闭合`);
  for (const match of doc.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^https?:\/\//.test(target)) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${name} 链接不存在：${target}`);
  }
  report.docs.push(name);
}
for (const stage of [1, 2, 3, 4, 5]) {
  const cwd = path.join(root, `demo${stage}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@openai/codex"], "0.154.0");
  const template = fs.readFileSync(path.join(cwd, ".env.example"), "utf8");
  assert.match(template, /^CODEX_API_KEY=$/m, "模板不能包含真实密钥");
  assert.ok(!/^AGENT_INSTRUCTIONS=/m.test(template), "角色不能回到环境变量中");
  assert.equal(fs.existsSync(path.join(cwd, "server/modules/memory/index.mjs")), stage >= 3);
  assert.equal(fs.existsSync(path.join(cwd, "agents/writing-agent.json")), stage >= 3);
}
assert.equal(fs.existsSync(path.join(root, 'demo3/server/modules/data/database.mjs')), false);
assert.equal(fs.existsSync(path.join(root, 'demo4/server/modules/knowledge/index.mjs')), false);
assert.equal(fs.existsSync(path.join(root, 'demo5/server/modules/permissions/index.mjs')), true);
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'demo3/package.json'))).dependencies.pg, undefined);
function run(directory, command, args) {
  const result = spawnSync(command, args, { cwd: path.join(root, directory), encoding: "utf8", timeout: 180000 });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const passed = result.status === 0;
  const record = { directory: directory || ".", command: [command, ...args].join(" "), passed,
    tests: Number(output.match(/(?:ℹ|#) tests (\d+)/)?.[1] || 0), skipped: Number(output.match(/(?:ℹ|#) skipped (\d+)/)?.[1] || 0) };
  report.checks.push(record);
  console.log(JSON.stringify(record));
  if (!passed) { console.error(result.error?.message || output); process.exitCode = 1; }
}
if (!options.has("--docs-only")) {
  for (const stage of [1, 2, 3, 4, 5]) run(`demo${stage}`, "npm", ["test"]);
  if (options.has("--integration") || options.has("--rag")) {
    run("", process.execPath, ["--test", "tests/evolution.integration.mjs"]);
    run("demo3", "npm", ["run", "test:codex-tools"]);
    run("demo3", "npm", ["run", "test:codex-memory"]);
    run("demo4", "npm", ["run", "test:data"]);
    run("demo5", "npm", ["run", options.has('--rag') ? "test:rag" : "test:data"]);
  }
}
console.log(JSON.stringify(report, null, 2));
if (!options.has("--docs-only")) fs.writeFileSync(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n");
