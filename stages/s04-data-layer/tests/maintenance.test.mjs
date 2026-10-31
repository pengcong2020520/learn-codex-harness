import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RunMaintenance, RUN_RETENTION } from "../server/modules/maintenance/index.mjs";
import { listProjectThreads, ensureThreadDirectory, rememberRunHistory } from "../server/modules/sessions/history.mjs";
import { prepareRun, finishRun } from "../server/modules/codex/runtime.mjs";
import { tempRoot, until } from "./helpers.mjs";

const day = 86400_000;
function ageTree(directory, time) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) ageTree(file, time); else fs.utimesSync(file, time / 1000, time / 1000);
  }
  fs.utimesSync(directory, time / 1000, time / 1000);
}
function run(root, name, age = 10 * day, files = { "models.json": "{}", "protocol.jsonl": "" }) {
  const directory = path.join(root, ".runs", `app-server-${name}`);
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), body);
  }
  ageTree(directory, Date.now() - age);
  return directory;
}
function maintenance(root, options = {}) {
  return new RunMaintenance({ root, inspectOpenPaths: async () => [], ...options });
}
function retainOne(root, options = {}) {
  run(root, "recent", 0);
  return maintenance(root, { policy: { ...RUN_RETENTION, keep: 1 }, ...options });
}
const rows = thread => JSON.stringify({ direction: "server", message: { result: { thread } } }) + "\n";

test("默认只清理超过 7 天且不在最近 5 次之内的运行目录，不碰资料和聊天正文", async t => {
  const root = tempRoot(t), old = Array.from({ length: 8 }, (_, i) => run(root, `old${i}`, (20 - i) * day));
  const fresh = run(root, "fresh", 0);
  fs.mkdirSync(path.join(root, "workspace/outputs"), { recursive: true });
  fs.writeFileSync(path.join(root, "workspace/outputs/article.md"), "article");
  fs.mkdirSync(path.join(root, ".data/codex/sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".data/codex/sessions/history.jsonl"), "conversation");
  const result = await maintenance(root).sweep();
  assert.equal(result.removed.length, 4); assert.ok(result.bytes > 0);
  old.slice(0, 4).forEach(dir => assert.equal(fs.existsSync(dir), false));
  [...old.slice(4), fresh].forEach(dir => assert.ok(fs.existsSync(dir)));
  assert.equal(fs.readFileSync(path.join(root, "workspace/outputs/article.md"), "utf8"), "article");
  assert.equal(fs.readFileSync(path.join(root, ".data/codex/sessions/history.jsonl"), "utf8"), "conversation");
  const index = path.join(root, ".data/session-index.json");
  assert.equal(JSON.parse(fs.readFileSync(index)).directories.length, 4);
  assert.equal(fs.statSync(index).mode & 0o777, 0o600);
});

test("删除日志后，原生会话筛选和旧版会话检索仍可用；索引不复制正文", async t => {
  const root = tempRoot(t), directory = run(root, "legacy");
  const rollout = path.join(root, "rollout.jsonl"); fs.writeFileSync(rollout, "original conversation");
  const legacy = { id: "old-id", cwd: directory, path: rollout, name: "历史观点", preview: "开场", originator: "app_server_project", turns: [{ private: "DO_NOT_INDEX" }] };
  fs.writeFileSync(path.join(directory, "protocol.jsonl"), rows(legacy));
  ageTree(directory, Date.now() - 10 * day);
  const cleaner = retainOne(root);
  assert.equal((await cleaner.sweep()).removed.length, 1);
  assert.equal(fs.existsSync(directory), false);
  const list = await listProjectThreads(async (method, params) => {
    assert.ok(params.cwd.includes(directory));
    return { data: [{ id: "native-id", cwd: directory, preview: "原生历史" }], nextCursor: null };
  }, root);
  assert.deepEqual(new Set(list.map(item => item.id)), new Set(["old-id", "native-id"]));
  assert.equal(list.find(item => item.id === "old-id").legacyPath, rollout);
  assert.ok(!fs.readFileSync(path.join(root, ".data/session-index.json"), "utf8").includes("DO_NOT_INDEX"));
  await ensureThreadDirectory(root, directory);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(fs.readFileSync(rollout, "utf8"), "original conversation");
});

test("当前运行、已加载会话、活进程及正在打开的文件都受到保护", async t => {
  const root = tempRoot(t);
  const current = run(root, "current"), loaded = run(root, "loaded"), opened = run(root, "opened");
  const alive = run(root, "alive", 10 * day, { "run.json": JSON.stringify({ version: 1, pid: process.pid, startedAt: 1 }) });
  const idle = run(root, "idle");
  const sessions = { loading: new Map(), sessions: new Map([["thread", { cwd: loaded }]]) };
  const result = await retainOne(root, { runtime: { workspace: current }, sessions,
    inspectOpenPaths: async () => [path.join(opened, "protocol.jsonl")] }).sweep();
  assert.deepEqual(result.removed, [path.basename(idle)]);
  [current, loaded, opened, alive].forEach(dir => assert.ok(fs.existsSync(dir)));
});

test("索引损坏、日志不完整、目录含用户文件或链接时保留原文件", async t => {
  const root = tempRoot(t), unknown = run(root, "unknown", 10 * day, { "article.md": "keep" });
  const malformed = run(root, "malformed", 10 * day, { "protocol.jsonl": '{"incomplete":' });
  const linked = run(root, "linked"); fs.symlinkSync(unknown, path.join(linked, "tools-link")); ageTree(linked, Date.now() - 10 * day);
  const corrupt = run(root, "corrupt");
  fs.mkdirSync(path.join(root, ".data"), { recursive: true }); fs.writeFileSync(path.join(root, ".data/session-index.json"), "broken");
  const result = await retainOne(root).sweep();
  assert.equal(result.removed.length, 0);
  [unknown, malformed, linked, corrupt].forEach(dir => assert.ok(fs.existsSync(dir)));
  assert.equal(fs.readFileSync(path.join(root, ".data/session-index.json"), "utf8"), "broken");
});

test("无法确认进程状态时不删除；索引落盘失败时也不删除", async t => {
  const root = tempRoot(t), directory = run(root, "old");
  const cleaner = retainOne(root, { inspectOpenPaths: async () => { throw new Error("cannot inspect"); } });
  assert.equal((await cleaner.sweep()).error, "cannot inspect");
  assert.ok(fs.existsSync(directory));
  fs.mkdirSync(path.join(root, ".data/session-index.json"), { recursive: true });
  const failed = await retainOne(root).sweep();
  assert.equal(failed.removed.length, 0); assert.ok(fs.existsSync(directory));
});

test("合法工具快照可清理，但最新文件修改时间决定保留期", async t => {
  const root = tempRoot(t), old = run(root, "old", 10 * day, {
    "tools-abc/config/tools/files.json": "{}", "tools-abc/server/modules/tools/files.mjs": "export {};", "protocol.jsonl": ""
  });
  const freshContent = run(root, "recent-change", 10 * day);
  fs.writeFileSync(path.join(freshContent, "protocol.jsonl"), "{}\n");
  const cleaner = retainOne(root);
  assert.deepEqual((await cleaner.sweep()).removed, [path.basename(old)]);
  assert.ok(fs.existsSync(freshContent));
});

test("检查期间开始恢复会话会跳过删除，重复清理请求复用同一轮", async t => {
  const root = tempRoot(t), directory = run(root, "old"), gate = Promise.withResolvers();
  const sessions = { loading: new Map(), sessions: new Map() };
  const cleaner = retainOne(root, { sessions, inspectOpenPaths: () => gate.promise });
  const first = cleaner.sweep(), second = cleaner.sweep(); assert.equal(first, second);
  sessions.loading.set("pending", Promise.resolve()); gate.resolve([]);
  assert.equal((await first).removed.length, 0); assert.ok(fs.existsSync(directory));
});

test("索引拒绝越界目录；重建会话目录拒绝符号链接", async t => {
  const root = tempRoot(t), other = path.join(root, "other"); fs.mkdirSync(other);
  await assert.rejects(rememberRunHistory(root, other), /之外/);
  await assert.rejects(ensureThreadDirectory(root, other), /不属于/);
  fs.mkdirSync(path.join(root, ".runs"));
  fs.symlinkSync(other, path.join(root, ".runs/app-server-link"));
  await assert.rejects(ensureThreadDirectory(root, path.join(root, ".runs/app-server-link")), /符号链接/);
});

test("运行生命周期标记进程身份和结束时间，重复结束不会反复改写", async t => {
  const root = tempRoot(t), runtime = await prepareRun({ args: [] }, root);
  const file = path.join(runtime.workspace, "run.json");
  assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
  finishRun(runtime.workspace);
  const state = fs.readFileSync(file, "utf8"); assert.ok(JSON.parse(state).stoppedAt);
  finishRun(runtime.workspace); assert.equal(fs.readFileSync(file, "utf8"), state);
});

test("启动立即检查、定期重复检查、关闭后停止；dryRun 不改索引或缓存", async t => {
  const root = tempRoot(t), directory = run(root, "old");
  const cleaner = retainOne(root);
  const preview = await cleaner.sweep({ dryRun: true });
  assert.equal(preview.removed.length, 1); assert.ok(fs.existsSync(directory));
  assert.equal(fs.existsSync(path.join(root, ".data/session-index.json")), false);
  let calls = 0;
  cleaner.policy = { ...cleaner.policy, intervalMs: 10 };
  cleaner.sweep = async () => { calls++; };
  t.after(() => cleaner.close());
  await cleaner.start(); assert.equal(calls, 1);
  await until(() => calls > 1); await cleaner.close();
  const stopped = calls; await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls, stopped);
});

test("真实 lsof 检查保护打开的旧日志，关闭句柄后才清理", async t => {
  const root = tempRoot(t), directory = run(root, "old"); run(root, "recent", 0);
  const file = fs.openSync(path.join(directory, "protocol.jsonl"), "r");
  const cleaner = new RunMaintenance({ root, policy: { ...RUN_RETENTION, keep: 1 } });
  try { assert.equal((await cleaner.sweep()).removed.length, 0); assert.ok(fs.existsSync(directory)); }
  finally { fs.closeSync(file); }
  const result = await cleaner.sweep();
  assert.equal(result.error, undefined); assert.equal(result.removed.length, 1);
});
