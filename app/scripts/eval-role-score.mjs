// 角色评估打分：读取 eval-role.mjs 的运行记录，做硬性检查、统计 token，并用更强的模型做盲评，生成报告。
// node scripts/eval-role-score.mjs --dir <运行输出目录> --baseline current --candidate slim [--judge-model deepseek-v4-pro] [--env .env] [--no-judge]
// 盲评：同一场景第 i 次的两版交付物配成一对，以“甲 / 乙”匿名，交换先后各评一次；两次结论一致才算胜负，不一致记为持平。
// 每次评审结果存到 <运行输出目录>/judge/ 下，重新打分时直接复用，不重复花费。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { mainDocument, runChecks, stats, writtenPaths } from "./eval/checks.mjs";
import { loadScenarios } from "./eval-role.mjs";
import { modelEndpoint } from "../server/modules/gateway/index.mjs";

const app = fileURLToPath(new URL("../", import.meta.url));
const DIMENSIONS = ["需求符合", "准确与有据", "结构与可读", "完整性", "表达与风格"];

function readInputs(dir) {
  if (!dir) return "";
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => { const file = path.join(entry.parentPath, entry.name); return `【${path.relative(dir, file)}】\n${fs.readFileSync(file, "utf8")}`; }).join("\n\n");
}

export function loadRuns(dir, label, scenarioId) {
  const folder = path.join(dir, label, scenarioId);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => /^run-\d+\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"))).sort((a, b) => a.index - b.index);
}

export function tokenFigures(run) {
  const total = run.usage?.total;
  if (!total) return null;
  return { input: total.inputTokens, cached: total.cachedInputTokens, uncached: total.inputTokens - total.cachedInputTokens,
    output: total.outputTokens, reasoning: total.reasoningOutputTokens, total: total.totalTokens, requests: run.usage.requests };
}

// 两次评审（甲=基线 / 甲=候选）合并成候选相对基线的结果：win / tie / loss。
export function combine(first, second) {
  const toCandidate = (verdict, candidateIs) => verdict === "平" ? "tie" : verdict === candidateIs ? "win" : "loss";
  const a = toCandidate(first, "乙"), b = toCandidate(second, "甲");
  return a === b ? a : "tie";
}

function judgePrompt(scenario, inputsText, docA, docB) {
  const show = run => `【交付文档：${run.doc?.path || "没有保存交付物"}】\n${run.doc?.content || "（无）"}\n\n【助手最后的回复】\n${run.reply || "（无）"}`;
  return [
    { role: "system", content: "你是严格、公正的中文写作评审。你会看到同一个需求下两位助手（甲、乙）的产出。只根据需求、参考资料和评审重点判断，不因篇幅长短或先后顺序偏向任何一方；编造资料里没有的事实、数据、来源或用户经历是严重扣分项。只输出 JSON。" },
    { role: "user", content: `## 用户需求\n${scenario.prompt}\n\n## 参考资料（用户提供，助手可以读取）\n${inputsText.slice(0, 14000) || "（无，素材都在需求里）"}\n\n## 评审重点\n${scenario.judgeFocus}\n\n## 甲的产出\n${show(docA)}\n\n## 乙的产出\n${show(docB)}\n\n` +
      `请输出 JSON：{"dimensions": {${DIMENSIONS.map(d => `"${d}": "甲|乙|平"`).join(", ")}}, "scores": {"甲": 1-10, "乙": 1-10}, "overall": "甲|乙|平", "reason": "不超过 150 字，说明关键差异"}` },
  ];
}

// 读取流式响应：只拼接正文增量（推理增量只用来保持连接活跃），用量在最后一个事件里。
async function readStream(response) {
  const decoder = new TextDecoder();
  let buffer = "", text = "", usage = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, "");
      if (!line.trim().startsWith("data:") || data === "[DONE]") continue;
      const event = JSON.parse(data);
      text += event.choices?.[0]?.delta?.content || "";
      if (event.usage) usage = event.usage;
    }
  }
  return { text, usage };
}

// 用流式请求：评审模型要推理好几分钟，非流式响应在这期间没有数据，会被客户端（默认 5 分钟）或代理当作超时断开。
async function judge({ base, key, model }, messages) {
  const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0, response_format: { type: "json_object" }, max_tokens: 16000,
      stream: true, stream_options: { include_usage: true } }) });
  if (!response.ok) {
    const error = new Error(`评审请求失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  // 个别服务不支持流式，会直接返回完整 JSON。
  const { text, usage } = response.headers.get("content-type")?.includes("text/event-stream") ? await readStream(response)
    : await response.json().then(body => ({ text: body.choices?.[0]?.message?.content || "", usage: body.usage || null }));
  const verdict = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!["甲", "乙", "平"].includes(verdict.overall)) throw new Error(`评审结果格式不对：${text.slice(0, 200)}`);
  return { verdict, usage };
}

// 评审模型推理时间长，连接偶尔会被中途断开；断线、限流、服务端错误和格式不对时重试，其余错误直接报出。
async function judgeWithRetry(config, messages, { attempts = 3, delayMs = 5000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await judge(config, messages);
    } catch (error) {
      if (attempt >= attempts || error.retryable === false) throw error;
      console.error(`评审请求失败，${delayMs * attempt / 1000} 秒后第 ${attempt} 次重试：${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

// 已有评审结果就复用；同一对、同一先后顺序、同一评审模型只评一次。
async function cachedJudge(file, run) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const result = await run();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  return result;
}

const pct = (a, b) => b ? `${a > b ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%` : "-";
const num = value => value == null ? "-" : Math.round(value).toLocaleString("en-US");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { dir: { type: "string" }, baseline: { type: "string", default: "current" }, candidate: { type: "string", default: "slim" },
    "judge-model": { type: "string", default: "deepseek-v4-pro" }, env: { type: "string", default: path.join(app, ".env") }, "no-judge": { type: "boolean", default: false } } });
  const dir = path.resolve(values.dir);
  const env = { ...parseEnv(fs.readFileSync(values.env, "utf8")), ...process.env };
  const endpoint = modelEndpoint(env);
  const judgeConfig = { base: endpoint.baseUrl, key: endpoint.apiKey, model: values["judge-model"] };
  const retry = { delayMs: Number(env.EVAL_JUDGE_RETRY_MS || 5000) };
  const labels = [values.baseline, values.candidate];
  const result = { dir: path.basename(dir), baseline: values.baseline, candidate: values.candidate, judgeModel: values["no-judge"] ? null : judgeConfig.model, scenarios: [] };
  const judgeUsage = { prompt: 0, completion: 0 };

  for (const scenario of loadScenarios()) {
    const inputsText = readInputs(scenario.inputs);
    const runs = Object.fromEntries(labels.map(label => [label, loadRuns(dir, label, scenario.id).map(run => {
      const deliverable = scenario.checks.find(check => check.type === "deliverable")?.dir || "outputs", written = writtenPaths(run);
      return { ...run, doc: mainDocument(run.files, deliverable, written), checks: runChecks(scenario, { files: run.files, reply: run.reply, inputsText, written }), tokens: tokenFigures(run) };
    })]));
    if (!runs[values.baseline].length && !runs[values.candidate].length) continue;
    const entry = { id: scenario.id, name: scenario.name, variants: {}, pairs: [] };
    for (const label of labels) {
      const list = runs[label], checks = list.flatMap(run => run.checks);
      entry.variants[label] = { runs: list.length, completed: list.filter(run => run.status === "completed").length,
        checksPassed: checks.filter(check => check.pass).length, checksTotal: checks.length,
        failedChecks: [...new Set(checks.filter(check => !check.pass).map(check => check.label))],
        tokens: Object.fromEntries(["total", "input", "uncached", "cached", "output", "reasoning", "requests"].map(key => [key, stats(list.map(run => run.tokens?.[key]))])),
        elapsedSec: stats(list.map(run => Math.round(run.elapsedMs / 1000))),
        skillReads: list.map(run => run.tools.filter(tool => tool.tool === "skill_read").map(tool => tool.args?.name)),
        firstRequest: list.map(run => run.requestParts?.[0]).filter(Boolean) };
    }
    if (!values["no-judge"]) {
      for (const base of runs[values.baseline]) {
        const candidate = runs[values.candidate].find(run => run.index === base.index);
        if (!candidate) continue;
        const cache = order => path.join(dir, "judge", judgeConfig.model, `${values.baseline}-vs-${values.candidate}`, `${scenario.id}-${base.index}-${order}.json`);
        const first = await cachedJudge(cache("baseline-first"), () => judgeWithRetry(judgeConfig, judgePrompt(scenario, inputsText, base, candidate), retry));
        const second = await cachedJudge(cache("candidate-first"), () => judgeWithRetry(judgeConfig, judgePrompt(scenario, inputsText, candidate, base), retry));
        for (const { usage } of [first, second]) { judgeUsage.prompt += usage?.prompt_tokens || 0; judgeUsage.completion += usage?.completion_tokens || 0; }
        const pair = { index: base.index, result: combine(first.verdict.overall, second.verdict.overall),
          scores: { [values.baseline]: (first.verdict.scores?.["甲"] + second.verdict.scores?.["乙"]) / 2, [values.candidate]: (first.verdict.scores?.["乙"] + second.verdict.scores?.["甲"]) / 2 },
          dimensions: Object.fromEntries(DIMENSIONS.map(d => [d, combine(first.verdict.dimensions?.[d], second.verdict.dimensions?.[d])])),
          reasons: [first.verdict.reason, second.verdict.reason] };
        entry.pairs.push(pair);
        console.log(`${scenario.id} 第 ${base.index} 对：候选 ${pair.result}（${pair.scores[values.baseline]} vs ${pair.scores[values.candidate]}）`);
      }
    }
    result.scenarios.push(entry);
  }
  result.judgeUsage = judgeUsage;

  // 判定：质量（硬性检查通过率不低于基线，盲评负场不多于胜场）是红线；token 总量必须下降。
  const lines = [`# 角色提示词评估报告`, "", `- 运行目录：\`${path.basename(dir)}\``, `- 基线：\`${values.baseline}\`，候选：\`${values.candidate}\``,
    `- 盲评模型：${result.judgeModel || "未盲评"}（交换先后各评一次，两次一致才算胜负）`, ""];
  lines.push("## Token（每次运行的平均值，括号内为最小–最大）", "", `| 场景 | 版本 | 总 token | 输入 | 其中未命中缓存 | 输出（含推理） | 请求次数 | 耗时（秒） |`, "|---|---|---|---|---|---|---|---|");
  const range = s => s ? `${num(s.mean)}（${num(s.min)}–${num(s.max)}）` : "-";
  for (const entry of result.scenarios) for (const label of labels) {
    const v = entry.variants[label], t = v.tokens;
    lines.push(`| ${entry.name} | ${label} | ${range(t.total)} | ${num(t.input?.mean)} | ${num(t.uncached?.mean)} | ${num(t.output?.mean)} | ${num(t.requests?.mean)} | ${num(v.elapsedSec?.mean)} |`);
  }
  const totalBase = result.scenarios.reduce((sum, e) => sum + (e.variants[values.baseline].tokens.total?.mean || 0), 0);
  const totalCand = result.scenarios.reduce((sum, e) => sum + (e.variants[values.candidate].tokens.total?.mean || 0), 0);
  lines.push("", `四个场景合计（各取平均）：基线 ${num(totalBase)}，候选 ${num(totalCand)}，变化 ${pct(totalCand, totalBase)}。`, "");
  // --capture 记录了请求组成时，比较第一次请求里各部分的字符数（之后每次请求都会带上这些固定部分）。
  const firstParts = label => result.scenarios.flatMap(entry => entry.variants[label].firstRequest || []);
  if (firstParts(values.baseline).length && firstParts(values.candidate).length) {
    const keys = ["instructions", "tools", "message:developer", "message:user"], names = { instructions: "基础指令（角色 + 资源规则）", tools: "工具定义", "message:developer": "Skill 清单与权限说明", "message:user": "环境信息与用户需求" };
    const mean = (label, key) => stats(firstParts(label).map(parts => parts[key] || 0))?.mean;
    lines.push("## 每次请求的固定部分（第一次请求，字符数平均值）", "", "| 部分 | 基线 | 候选 | 变化 |", "|---|---|---|---|");
    for (const key of keys) lines.push(`| ${names[key]} | ${num(mean(values.baseline, key))} | ${num(mean(values.candidate, key))} | ${pct(mean(values.candidate, key), mean(values.baseline, key))} |`);
    lines.push("");
  }
  lines.push("## 质量", "", "| 场景 | 硬性检查（基线） | 硬性检查（候选） | 盲评（候选 胜/平/负） | 平均分（基线 → 候选） |", "|---|---|---|---|---|");
  const verdicts = [];
  for (const entry of result.scenarios) {
    const b = entry.variants[values.baseline], c = entry.variants[values.candidate];
    const count = kind => entry.pairs.filter(pair => pair.result === kind).length;
    const avg = label => entry.pairs.length ? (entry.pairs.reduce((s, p) => s + p.scores[label], 0) / entry.pairs.length).toFixed(1) : "-";
    lines.push(`| ${entry.name} | ${b.checksPassed}/${b.checksTotal} | ${c.checksPassed}/${c.checksTotal} | ${count("win")}/${count("tie")}/${count("loss")} | ${avg(values.baseline)} → ${avg(values.candidate)} |`);
    const qualityOk = c.checksPassed / (c.checksTotal || 1) >= b.checksPassed / (b.checksTotal || 1) && count("loss") <= count("win");
    const tokensOk = (c.tokens.total?.mean ?? Infinity) < (b.tokens.total?.mean ?? 0);
    verdicts.push({ id: entry.id, name: entry.name, qualityOk, tokensOk });
  }
  lines.push("", "## 结论", "");
  for (const v of verdicts) lines.push(`- ${v.name}：质量 ${v.qualityOk ? "不低于基线" : "**低于基线（红线）**"}；token ${v.tokensOk ? "下降" : "**没有下降**"}。`);
  result.passed = verdicts.every(v => v.qualityOk) && totalCand < totalBase;
  lines.push("", result.passed ? "**通过**：各场景质量不低于基线，token 合计下降。" : "**未通过**：见上面标出的场景。");
  lines.push("", "## 明细", "");
  for (const entry of result.scenarios) {
    lines.push(`### ${entry.name}`, "");
    for (const label of labels) {
      const v = entry.variants[label];
      lines.push(`- ${label}：完成 ${v.completed}/${v.runs}；未通过的检查：${v.failedChecks.join("、") || "无"}；读取的 Skill：${v.skillReads.map(list => list.join("+") || "无").join(" / ")}`);
    }
    for (const pair of entry.pairs) lines.push(`- 第 ${pair.index} 对：候选 ${({ win: "胜", tie: "平", loss: "负" })[pair.result]}；${pair.reasons.filter(Boolean).join(" ／ ")}`);
    lines.push("");
  }
  if (!values["no-judge"]) lines.push(`盲评消耗：输入 ${num(judgeUsage.prompt)} token，输出 ${num(judgeUsage.completion)} token。`);
  fs.writeFileSync(path.join(dir, "scores.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}
