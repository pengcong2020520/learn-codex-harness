import test from "node:test";
import assert from "node:assert/strict";
import { mainDocument, textLength, headingCount, runChecks, stats } from "../scripts/eval/checks.mjs";
import { loadScenarios } from "../scripts/eval-role.mjs";

const scenario = checks => ({ id: "t", checks: [{ id: "deliverable", label: "交付物", type: "deliverable", dir: "outputs" }, ...checks] });
const results = (checks, context) => Object.fromEntries(runChecks(scenario(checks), context).map(item => [item.id, item]));

test("交付物取 outputs/ 下最长的 Markdown 或文本，字数不计空白与 Markdown 标记", () => {
  const files = [{ path: "drafts/outline.md", content: "x".repeat(900) }, { path: "outputs/notes/n.txt", content: "短" },
    { path: "outputs/doc.md", content: "# 标题\n\n正文 **重点**" }, { path: "outputs/image.png", content: "y".repeat(500) }];
  assert.equal(mainDocument(files, "outputs").path, "outputs/doc.md");
  assert.equal(mainDocument(files, "research"), null);
  assert.equal(textLength("# 标题\n\n正文 **重点** - a | b"), 8);
  assert.equal(headingCount("# 一\n正文 # 不算\n## 二\n###三"), 2);
});

test("各类检查：包含、全部包含、排除、结尾提问、开头结论、篇幅与标题数", () => {
  const doc = "# 汇报\n结论：解决率 63%，未达 65% 目标。\n## 成果\n满意度 4.4\n## 问题\n你怎么看？";
  const r = results([
    { id: "any", label: "", type: "includes", any: ["不存在", "63\\s*%"] },
    { id: "all", label: "", type: "includes-all", all: ["63\\s*%", "4\\.4", "1,?850"] },
    { id: "ex", label: "", type: "excludes", patterns: ["被\\s*AI\\s*取代"] },
    { id: "q", label: "", type: "ending-question", within: 50 },
    { id: "open", label: "", type: "opening-includes", within: 20, any: ["结论"] },
    { id: "len", label: "", type: "length", min: 10, max: 100 },
    { id: "h", label: "", type: "headings", min: 4 },
  ], { files: [{ path: "outputs/r.md", content: doc }] });
  assert.equal(r.deliverable.pass, true);
  assert.equal(r.any.pass, true);
  assert.deepEqual([r.all.pass, r.all.detail], [false, "缺少：1,?850"]);
  assert.equal(r.ex.pass, true);
  assert.equal(r.q.pass, true);
  assert.equal(r.open.pass, true);
  assert.equal(r.len.pass, true);
  assert.deepEqual([r.h.pass, r.h.detail], [false, "3 个标题"]);
});

test("没有交付物时依赖正文的检查都不算通过；doc+reply 会同时看最终回复", () => {
  const r = results([
    { id: "ex", label: "", type: "excludes", patterns: ["x"] },
    { id: "urls", label: "", type: "urls-from-inputs" },
    { id: "honest", label: "", type: "includes", where: "doc+reply", any: ["搜索[^\\n]{0,10}失败"] },
  ], { files: [], reply: "联网搜索失败了，以下只基于你提供的资料。" });
  assert.equal(r.deliverable.pass, false);
  assert.equal(r.ex.pass, false);
  assert.equal(r.urls.pass, false);
  assert.equal(r.honest.pass, true);
});

test("链接必须来自资料：资料里出现过的链接放行，其余视为编造", () => {
  const inputsText = "来源：https://yunjian.example/pricing （官网）";
  const r = results([{ id: "urls", label: "", type: "urls-from-inputs" }], { inputsText, files: [{ path: "outputs/r.md",
    content: "价格见 [官网](https://yunjian.example/pricing)，另见 https://yunjian.example/pricing。\n还有 https://made-up.example/report）" }] });
  assert.equal(r.urls.pass, false);
  assert.equal(r.urls.detail, "资料以外的链接：https://made-up.example/report");
});

test("统计：均值、最小、最大，忽略缺失值", () => {
  assert.deepEqual(stats([10, 20, null, 30]), { mean: 20, min: 10, max: 30, n: 3 });
  assert.equal(stats([]), null);
});

test("内置的四个评估场景格式正确、检查项都能执行", () => {
  const scenarios = loadScenarios();
  assert.deepEqual(scenarios.map(s => s.id), ["s1-local-doc", "s2-wechat", "s3-research", "s4-report"]);
  for (const s of scenarios) {
    assert.ok(s.prompt.length > 50 && s.judgeFocus, s.id);
    assert.equal(s.checks[0].type, "deliverable", s.id);
    assert.equal(runChecks(s, { files: [] }).length, s.checks.length, s.id);
  }
});

test("盲评合并：两次（交换先后）结论一致才算胜负，不一致记为持平", async () => {
  const { combine, tokenFigures } = await import("../scripts/eval-role-score.mjs");
  // 第一次：甲=基线、乙=候选；第二次：甲=候选、乙=基线。
  assert.equal(combine("乙", "甲"), "win");
  assert.equal(combine("甲", "乙"), "loss");
  assert.equal(combine("乙", "乙"), "tie", "两次都选后出现的一方，是位置偏好");
  assert.equal(combine("平", "甲"), "tie");
  assert.equal(combine("平", "平"), "tie");
  assert.deepEqual(tokenFigures({ usage: { requests: 4, total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 300, reasoningOutputTokens: 100, totalTokens: 1300 } } }),
    { input: 1000, cached: 600, uncached: 400, output: 300, reasoning: 100, total: 1300, requests: 4 });
  assert.equal(tokenFigures({ usage: { requests: 0, total: null } }), null);
});

test("打分脚本：不盲评时也能按硬性检查与 token 生成报告和判定", async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "eval-score-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = "# Q3 汇报\n结论：解决率 63%，未达 65% 目标。\n## 成果\n满意度 4.4，转人工 31%，节省 1,850 小时。\n## 问题\n更新滞后 9 天，粤语 71%，工单 18%。\n## 支持\n2 名标注、IT 排期、15 万预算。\n" + "说明。".repeat(300);
  const run = (label, total, content) => {
    mkdirSync(join(dir, label, "s4-report"), { recursive: true });
    writeFileSync(join(dir, label, "s4-report", "run-1.json"), JSON.stringify({ label, scenario: "s4-report", index: 1, status: "completed", elapsedMs: 60000, reply: "已保存。",
      usage: { requests: 5, total: { inputTokens: total - 1000, cachedInputTokens: 2000, outputTokens: 1000, reasoningOutputTokens: 400, totalTokens: total } },
      tools: [{ tool: "skill_read", args: { name: "work-report" } }], files: [{ path: "outputs/r.md", content }] }));
  };
  run("current", 40000, doc); run("slim", 30000, doc);
  writeFileSync(join(dir, "empty.env"), "");
  const script = new URL("../scripts/eval-role-score.mjs", import.meta.url).pathname;
  execFileSync(process.execPath, [script, "--dir", dir, "--no-judge", "--env", join(dir, "empty.env")], { encoding: "utf8" });
  const report = readFileSync(join(dir, "report.md"), "utf8"), scores = JSON.parse(readFileSync(join(dir, "scores.json"), "utf8"));
  assert.match(report, /\| 写汇报材料 \| current \| 40,000（40,000–40,000）/);
  assert.match(report, /基线 40,000，候选 30,000，变化 -25\.0%/);
  assert.match(report, /写汇报材料：质量 不低于基线；token 下降/);
  assert.match(report, /读取的 Skill：work-report/);
  assert.equal(scores.passed, true);

  run("slim", 50000, "# 只有标题");
  execFileSync(process.execPath, [script, "--dir", dir, "--no-judge", "--env", join(dir, "empty.env")], { encoding: "utf8" });
  const worse = readFileSync(join(dir, "report.md"), "utf8");
  assert.match(worse, /质量 \*\*低于基线（红线）\*\*；token \*\*没有下降\*\*/);
  assert.equal(JSON.parse(readFileSync(join(dir, "scores.json"), "utf8")).passed, false);
});
