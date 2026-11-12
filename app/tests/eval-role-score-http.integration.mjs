import test from "node:test";
import assert from "node:assert/strict";
test("打分脚本盲评：连接中途断开会重试；评审结果存盘，重新打分时不再请求", async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const http = await import("node:http");
  const dir = mkdtempSync(join(tmpdir(), "eval-judge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = marker => `# Q3 汇报\n结论：解决率 63%，未达 65% 目标。${marker}\n## 成果\n满意度 4.4，转人工 31%，节省 1,850 小时。\n` + "说明。".repeat(300);
  for (const [label, marker] of [["current", "基线稿"], ["slim", "候选稿"]]) {
    mkdirSync(join(dir, label, "s4-report"), { recursive: true });
    writeFileSync(join(dir, label, "s4-report", "run-1.json"), JSON.stringify({ label, scenario: "s4-report", index: 1, status: "completed", elapsedMs: 1000, reply: "已保存。",
      usage: { requests: 1, total: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 } },
      tools: [{ tool: "write_file", args: { path: "outputs/r.md" } }], files: [{ path: "outputs/r.md", content: doc(marker) }] }));
  }
  // 模拟评审服务：总是判“候选稿”更好。第一次请求直接断开连接；第二次按流式返回（正文分几段，夹着推理增量）；第三次返回完整 JSON（不支持流式的服务）。
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      if (requests.length === 1) return req.socket.destroy();
      const prompt = requests.at(-1).messages[1].content, a = prompt.slice(prompt.indexOf("## 甲的产出"), prompt.indexOf("## 乙的产出"));
      const winner = a.includes("候选稿") ? "甲" : "乙";
      const content = JSON.stringify({ dimensions: {}, scores: { 甲: winner === "甲" ? 9 : 7, 乙: winner === "乙" ? 9 : 7 }, overall: winner, reason: "候选更好" });
      const usage = { prompt_tokens: 1000, completion_tokens: 100 };
      if (requests.length === 2) {
        res.setHeader("content-type", "text/event-stream");
        const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
        send({ choices: [{ delta: { reasoning_content: "先比较两份。" } }] });
        send({ choices: [{ delta: { content: content.slice(0, 20) } }] });
        send({ choices: [{ delta: { reasoning_content: "再看数据。" } }] });
        send({ choices: [{ delta: { content: content.slice(20) } }] });
        send({ choices: [], usage });
        return res.end("data: [DONE]\n\n");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  writeFileSync(join(dir, "empty.env"), "");
  const script = new URL("../scripts/eval-role-score.mjs", import.meta.url).pathname;
  const env = { ...process.env, CODEX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, CODEX_API_KEY: "local-test-only", EVAL_JUDGE_RETRY_MS: "10" };
  const score = () => promisify(execFile)(process.execPath, [script, "--dir", dir, "--env", join(dir, "empty.env")], { env, encoding: "utf8" });

  const { stderr } = await score();
  assert.match(stderr, /第 1 次重试/);
  assert.equal(requests.length, 3, "断开的一次 + 交换先后的两次");
  assert.ok(requests.every(request => request.stream === true && request.stream_options?.include_usage), "用流式请求，避免长时间推理时连接被当作超时断开");
  assert.match(readFileSync(join(dir, "report.md"), "utf8"), /\| 写汇报材料 \| 5\/8 \| 5\/8 \| 1\/0\/0 \| 7\.0 → 9\.0 \|/);
  assert.equal(readdirSync(join(dir, "judge", "deepseek-v4-pro", "current-vs-slim")).length, 2);

  await score();
  assert.equal(requests.length, 3, "已有评审结果直接复用");
  const scores = JSON.parse(readFileSync(join(dir, "scores.json"), "utf8"));
  assert.equal(scores.scenarios[0].pairs[0].result, "win");
  assert.deepEqual(scores.judgeUsage, { prompt: 2000, completion: 200 });
});
