// 不读取 .env、不调用真实模型；完整验证后更新根目录的验收记录。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("./", import.meta.url));
// s01–s05 即课程里的 Demo 1–5；s06 起只有章节，暂未接入课程。s00 是 SDK 入门，只有章节文档，没有设计说明。
const STAGES = { 1: "s01-single-turn", 2: "s02-multi-turn", 3: "s03-agent-core", 4: "s04-data-layer", 5: "s05-knowledge-layer", 6: "s06-skill-workflow", 7: "s07-model-gateway" };
const CHAPTERS = ["s00-sdk-quickstart", ...Object.values(STAGES)];
const options = new Set(process.argv.slice(2));
if ([...options].some(option => !["--integration", "--docs-only", "--rag"].includes(option))) {
  throw new Error("用法：node verify.mjs [--integration [--rag] | --docs-only]");
}
const report = { verifiedAt: new Date().toISOString(), modelProvider: "local simulated Responses", embeddingProvider: options.has("--rag") ? "local deterministic 3D fixture" : null, semanticQualityVerified: false, docs: [], checks: [] };
// 章节 README 先讲概念与分工，再动手、看代码：要回答的问题 → 核心概念 → 分工 → 跑起来看看 → 关键代码 → 小结 → 下一章；
// 每章标出对应导论里"六个问题"中的哪几个。docs/design.md 保留原有的设计原理 → 架构改进 → 技术实现流程 → 核心代码（伪代码）。
const CHAPTER_HEADINGS = ["要回答的问题", "核心概念", "分工：Codex 做什么，我们做什么", "跑起来看看", "关键代码", "小结", "下一章"];
const docs = [
  ["README.md", "overview"],
  ["introduction.md", "introduction"],
  ...CHAPTERS.map(dir => [`${dir}/README.md`, "chapter"]),
  ...Object.values(STAGES).map(dir => [`${dir}/docs/design.md`, "design"]),
  ["s00-sdk-quickstart/docs/guide.md", "reference"],
  ["s03-agent-core/docs/tools.md", "reference"],
  ["s04-data-layer/docs/data-layer.md", "reference"],
  ["s05-knowledge-layer/docs/knowledge-implementation.md", "reference"],
  ["s06-skill-workflow/docs/skill-workflow-design.md", "reference"],
  ["s07-model-gateway/docs/model-gateway.md", "reference"],
];
function sourceLines(dir) {
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", ".data", ".runs", "workspace", "docs", "images"].includes(entry.name)) return [];
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? walk(file) : /\.(mjs|js|json|sql)$/.test(entry.name) ? [file] : [];
  });
  return walk(dir).flatMap(file => fs.readFileSync(file, "utf8").split("\n").map(line => line.replace(/\s+/g, " ").trim()));
}
// 章节里的 javascript / sql 代码块必须摘自本阶段源码：跳过注释、省略号与纯标点行，其余每一行都要能在源码中找到。
function assertExcerpts(stage, doc, name) {
  const lines = sourceLines(path.join(root, stage));
  for (const block of doc.matchAll(/^```(?:javascript|sql)\n([\s\S]*?)^```/gm)) {
    for (const raw of block[1].split("\n")) {
      const code = raw.replace(/\s+/g, " ").replace(/\s\/\/ .*$/, "").trim();
      if (!code || code.startsWith("//") || code.includes("…") || /^[{}()\[\],;]+$/.test(code)) continue;
      assert.ok(lines.some(line => line.includes(code)), `${name} 的代码摘录与源码不一致：${code}`);
    }
  }
}
for (const [name, kind] of docs) {
  const file = path.join(root, name), doc = fs.readFileSync(file, "utf8");
  if (kind === "chapter") {
    const stage = name.split("/")[0], id = stage.slice(0, 3);
    assert.ok(doc.startsWith(`# ${id}: `), `${name} 标题应以「${id}: 」开头`);
    assert.ok(doc.includes(`\`${id}\` → `) || doc.includes(`→ \`${id}\``), `${name} 缺少章节导航`);
    for (const heading of CHAPTER_HEADINGS) {
      assert.ok(doc.includes(`## ${heading}\n`), `${name} 缺少 ${heading}`);
    }
    assert.match(doc, /^> \*\*对应六个问题\*\*：/m, `${name} 缺少「对应六个问题」`);
    assert.ok(doc.includes("[导论](../introduction.md)"), `${name} 的章节导航缺少导论`);
    assertExcerpts(stage, doc, name);
  }
  if (kind === "introduction") {
    assert.ok(doc.startsWith("# 导论："), `${name} 标题应以「导论：」开头`);
    for (const question of ["① 我是谁？", "② 要做什么，做到什么算完？", "③ 之前聊过什么？", "④ 依据什么资料？", "⑤ 能用什么？", "⑥ 谁说了算？"]) {
      assert.ok(doc.includes(question), `${name} 缺少六个问题之一：${question}`);
    }
  }
  if (kind === "design") {
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
for (const stage of Object.keys(STAGES).map(Number)) {
  const cwd = path.join(root, STAGES[stage]);
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@openai/codex"], "0.154.0");
  const template = fs.readFileSync(path.join(cwd, ".env.example"), "utf8");
  assert.match(template, /^CODEX_API_KEY=$/m, "模板不能包含真实密钥");
  assert.ok(!/^AGENT_INSTRUCTIONS=/m.test(template), "角色不能回到环境变量中");
  assert.equal(fs.existsSync(path.join(cwd, "server/modules/memory/index.mjs")), stage >= 3);
  // s06 起 Agent 定义改为 Agent 包：agents/<id>/agent.json。
  assert.equal(fs.existsSync(path.join(cwd, "agents/writing-agent.json")), stage >= 3 && stage < 6);
  assert.equal(fs.existsSync(path.join(cwd, "agents/writing/agent.json")), stage >= 6);
  assert.equal(fs.existsSync(path.join(cwd, "server/modules/workflows/index.mjs")), stage >= 6);
  for (const file of ["config/models.json", "server/modules/gateway/index.mjs", "server/modules/gateway/router.mjs", "server/modules/usage/index.mjs"]) {
    assert.equal(fs.existsSync(path.join(cwd, file)), stage >= 7, `${STAGES[stage]}: ${file}`);
  }
  if (stage >= 7) {
    for (const file of ["snapshot.json", "lessons/catalog.json", "lessons/run.mjs", "lessons/README.md", "images/model-gateway.svg", "images/architecture.svg"]) {
      assert.ok(fs.existsSync(path.join(cwd, file)), `${STAGES[stage]}: ${file}`);
    }
  }
}
// 各阶段总架构图由同一份模块数据生成，必须与生成脚本一致。
const diagrams = spawnSync(process.execPath, [path.join(root, "build-architecture.mjs"), "--check"], { encoding: "utf8" });
assert.equal(diagrams.status, 0, diagrams.stderr);
// 阶段增量（stages/changes.json、CHANGES.md）也由快照生成，必须是最新的。
const changes = spawnSync(process.execPath, [path.join(root, "build-changes.mjs"), "--check"], { encoding: "utf8" });
assert.equal(changes.status, 0, changes.stderr);
assert.equal(fs.existsSync(path.join(root, 's03-agent-core/server/modules/data/database.mjs')), false);
assert.equal(fs.existsSync(path.join(root, 's04-data-layer/server/modules/knowledge/index.mjs')), false);
assert.equal(fs.existsSync(path.join(root, 's05-knowledge-layer/server/modules/permissions/index.mjs')), true);
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 's03-agent-core/package.json'))).dependencies.pg, undefined);
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
  run("s00-sdk-quickstart", "npm", ["test"]);
  for (const stage of Object.keys(STAGES).map(Number)) run(STAGES[stage], "npm", ["test"]);
  if (options.has("--integration") || options.has("--rag")) {
    run("", process.execPath, ["--test", "tests/evolution.integration.mjs"]);
    run("s03-agent-core", "npm", ["run", "test:codex-tools"]);
    run("s03-agent-core", "npm", ["run", "test:codex-memory"]);
    run("s04-data-layer", "npm", ["run", "test:data"]);
    run("s05-knowledge-layer", "npm", ["run", options.has('--rag') ? "test:rag" : "test:data"]);
    run("s06-skill-workflow", "npm", ["run", "test:codex-tools"]);
    run("s06-skill-workflow", "npm", ["run", "test:data"]);
  }
}
console.log(JSON.stringify(report, null, 2));
if (!options.has("--docs-only")) fs.writeFileSync(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n");
