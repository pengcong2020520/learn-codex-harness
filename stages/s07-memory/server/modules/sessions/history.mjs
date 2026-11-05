// 会话搜索仅限本项目；历史正文由 Codex 保存，不自行拼接模型上下文。
import { readdir, mkdir, copyFile, link, unlink, chmod, lstat } from "node:fs/promises";
import { createReadStream, existsSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { PROJECT_ROOT } from "../../../shared/paths.mjs";
import { readJson, writeJson } from "../storage/index.mjs";
import { RUN_NAME } from "../codex/runtime.mjs";

function readIndex(root) {
  const index = readJson(path.join(root, ".data", "session-index.json"), { version: 1, directories: [], threads: [] });
  if (index?.version !== 1 || !Array.isArray(index.directories) || !index.directories.every(name => typeof name === "string" && RUN_NAME.test(name)) ||
      !Array.isArray(index.threads) || !index.threads.every(thread => typeof thread?.id === "string" && typeof thread.cwd === "string" && typeof thread.path === "string" && path.isAbsolute(thread.path))) {
    throw new Error("会话索引格式无效；不会清理运行目录或覆盖索引。");
  }
  return index;
}

async function loggedThreads(directory, strict = false) {
  const file = path.join(directory, "protocol.jsonl");
  const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("协议日志不是普通文件，已停止读取。");
  const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
  const threads = new Map();
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (!strict && !line.includes('"thread":')) continue;
      let row;
      try { row = JSON.parse(line); } catch { if (strict) throw new Error("协议日志不完整，保留原运行目录。"); continue; }
      const thread = row.direction === "server" && row.message?.result?.thread;
      if (!thread?.id || typeof thread.cwd !== "string" || typeof thread.path !== "string" || !path.isAbsolute(thread.path)) continue;
      // 只留检索所需的元数据，不把 turns、正文和工具输出复制进索引。
      const { id, cwd, path: rollout, name, preview, originator, createdAt, updatedAt } = thread;
      threads.set(id, { id, cwd, path: rollout, name, preview, originator, createdAt, updatedAt });
    }
  } finally { lines.close(); input.destroy(); }
  return [...threads.values()];
}

// 必须在删除日志之前持久化。目录来源与旧版 rollout 路径不再依赖日志文件存在。
export async function rememberRunHistory(root, directory, workspaceDir) {
  const runs = path.resolve(root, ".runs"), name = path.basename(directory);
  if (path.dirname(path.resolve(directory)) !== runs || !RUN_NAME.test(name)) throw new Error("不允许索引项目运行目录之外的路径。");
  const discovered = await loggedThreads(directory, true);
  // 读取放在 await 之后，避免并行检索/维护覆盖刚保存的索引。
  const index = readIndex(root), directories = new Set([...index.directories, name]);
  const allowed = cwd => cwd === workspaceDir || (path.dirname(path.resolve(cwd)) === runs && RUN_NAME.test(path.basename(cwd)));
  const threads = new Map(index.threads.map(thread => [thread.id, thread]));
  for (const thread of discovered) {
    if (!allowed(thread.cwd) || (thread.originator && thread.originator !== "app_server_project")) continue;
    if (thread.path === directory || thread.path.startsWith(directory + path.sep)) throw new Error("运行目录内包含会话正文，不能作为缓存清理。");
    if (thread.cwd !== workspaceDir) directories.add(path.basename(thread.cwd));
    threads.set(thread.id, { ...threads.get(thread.id), ...thread });
  }
  writeJson(path.join(root, ".data", "session-index.json"), { version: 1, directories: [...directories], threads: [...threads.values()] });
}

export async function ensureThreadDirectory(root, directory, workspaceDir) {
  if (workspaceDir) {
    if (path.resolve(directory) !== workspaceDir) throw new Error("旧会话工作区与当前绑定不一致，请新建会话；不会改写旧 cwd。");
    let info;
    try { info = await lstat(directory); } catch (error) { if (error.code === "ENOENT") throw new Error("会话工作区不存在，请恢复原目录后重试。"); throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("会话目录不能是符号链接或普通文件。");
    return;
  }
  const runs = path.resolve(root, ".runs");
  if (path.dirname(path.resolve(directory)) !== runs || !RUN_NAME.test(path.basename(directory))) throw new Error("会话目录不属于本项目。");
  for (const target of [runs, directory]) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("会话目录不能是符号链接。");
  }
}

export async function importLegacyThread(root, thread) {
  if (!thread.legacyPath) return;
  // 0.154.0 的跨 CODEX_HOME 按 path 恢复仍依赖本地 rollout 查找。
  // 只在用户选择旧 Thread 时复制其记录；保留原文件，不改 Thread id，不覆盖已迁移记录。
  const date = path.basename(thread.legacyPath).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!date) throw new Error("旧会话文件名不符合 Codex 记录格式。");
  const input = createReadStream(thread.legacyPath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    const first = (await lines[Symbol.asyncIterator]().next()).value;
    const metadata = JSON.parse(first);
    if (metadata.type !== "session_meta" || metadata.payload.id !== thread.id || path.resolve(metadata.payload.cwd) !== path.resolve(thread.cwd)) throw new Error("旧会话元数据不匹配，未迁移。");
  } finally { lines.close(); input.destroy(); }
  const directory = path.join(root, ".data/codex/sessions", ...date.slice(1));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, path.basename(thread.legacyPath));
  if (existsSync(target)) return target;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(thread.legacyPath, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    try { await link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  return target;
}

export async function listProjectThreads(request, root = PROJECT_ROOT, keyword = "", workspaceDir) {
  const runs = path.resolve(root, ".runs");
  const index = readIndex(root);
  const entries = await readdir(runs, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const physical = entries.filter(entry => entry.isDirectory() && RUN_NAME.test(entry.name)).map(entry => path.join(runs, entry.name));
  const cwd = [...new Set([...(workspaceDir ? [workspaceDir] : []), ...physical, ...index.directories.map(name => path.join(runs, name))])];
  if (!cwd.length) return [];
  const allowed = new Set(cwd);
  const found = new Map();
  const known = new Set();
  const seenCursors = new Set();
  const query = keyword.trim().toLocaleLowerCase();
  let cursor;
  do {
    const page = await request("thread/list", {
      limit: 100, sortKey: "updated_at", sortDirection: "desc",
      // 0.154.0 的 stdio app-server 实际可能记录为 vscode；不能只筛 appServer。
      sourceKinds: ["appServer", "vscode"], modelProviders: [], archived: false, cwd,
      ...(cursor ? { cursor } : {})
    });
    for (const thread of page.data) {
      if (!thread.cwd || !allowed.has(path.resolve(thread.cwd))) continue;
      if (thread.originator && thread.originator !== "app_server_project") continue;
      known.add(thread.id);
      // 本地搜索名称、开场预览和 ID；不是整段聊天的全文搜索。
      if (![thread.name, thread.preview, thread.id].some(value => String(value || "").toLocaleLowerCase().includes(query))) continue;
      found.set(thread.id, thread);
    }
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("会话列表返回了重复分页游标，请稍后重试。");
    seenCursors.add(cursor);
  } while (cursor);
  // 旧版 Thread 存在个人 Codex 目录中。只从本项目索引和协议日志取回已知路径，
  // 不扫描个人全部聊天，也不改动旧记录；只在用户选择时迁移那一个 Thread。
  const legacy = [...readIndex(root).threads];
  for (const directory of physical) legacy.push(...await loggedThreads(directory));
  for (const thread of legacy) {
    if (!thread?.id || known.has(thread.id) || found.has(thread.id) || !thread.cwd || !allowed.has(path.resolve(thread.cwd)) ||
      typeof thread.path !== "string" || !path.isAbsolute(thread.path) || !existsSync(thread.path)) continue;
    if (thread.originator && thread.originator !== "app_server_project") continue;
    if (![thread.name, thread.preview, thread.id].some(value => String(value || "").toLocaleLowerCase().includes(query))) continue;
    found.set(thread.id, { ...thread, legacyPath: thread.path });
  }
  return [...found.values()].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}
