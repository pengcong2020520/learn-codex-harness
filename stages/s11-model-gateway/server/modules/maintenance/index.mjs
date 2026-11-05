import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RUN_NAME } from "../codex/runtime.mjs";
import { rememberRunHistory } from "../sessions/history.mjs";
import { readJson } from "../storage/index.mjs";

export const RUN_RETENTION = Object.freeze({ maxAgeMs: 7 * 86400_000, keep: 5, intervalMs: 3600_000 });
const exec = promisify(execFile);

// 对旧版本没有 run.json 的目录，也检查进程正在使用的 cwd 和打开的文件。
// 系统没有 lsof 或无法完整检查时跳过清理，不猜测目录已闲置。
async function openPaths(runs) {
  let output;
  try { output = await exec("lsof", ["-nP", "-Fn", "+D", runs], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) {
    // macOS 对部分目录无匹配也会返回 1；仍需处理 stdout 中已找到的占用。
    if (error.code === 1 && !error.stderr) output = { stdout: error.stdout || "", stderr: "" };
    else throw new Error("无法确认运行目录是否被进程使用；本次不清理（需要可用的 lsof）。");
  }
  if (output.stderr.trim()) throw new Error("运行目录的进程检查不完整，本次不清理。");
  const physical = fs.realpathSync(runs);
  return output.stdout.split("\n").filter(line => line.startsWith("n")).map(line => {
    const file = line.slice(1);
    return file === physical || file.startsWith(physical + path.sep) ? path.join(runs, path.relative(physical, file)) : file;
  });
}

function inspectCache(directory) {
  const stamp = [], result = { bytes: 0, modified: 0 };
  function visit(relative = "") {
    const target = path.join(directory, relative), info = fs.lstatSync(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("含链接或特殊文件");
    result.modified = Math.max(result.modified, info.mtimeMs);
    stamp.push([relative, info.ino, info.size, info.mtimeMs]);
    if (info.isFile()) { result.bytes += info.size; return; }
    for (const name of fs.readdirSync(target).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (!relative) {
        const item = fs.lstatSync(path.join(directory, child));
        if (!(item.isFile() && ["models.json", "protocol.jsonl", "run.json"].includes(name)) &&
            !(item.isDirectory() && /^tools-[a-zA-Z0-9]+$/.test(name))) throw new Error("含非缓存内容");
      } else {
        const local = child.split("/").slice(1).join("/");
        const item = fs.lstatSync(path.join(directory, child));
        const allowed = item.isDirectory()
          ? ["config/tools", "server/modules/tools"].some(base => base === local || base.startsWith(local + "/") || local.startsWith(base + "/"))
          : /^config\/tools\/.+\.json$/.test(local) || /^server\/modules\/tools\/.+\.mjs$/.test(local);
        if (!allowed || local.split("/").some(part => part.startsWith("."))) throw new Error("工具快照含未知内容");
      }
      visit(child);
    }
  }
  visit();
  return { ...result, stamp: JSON.stringify(stamp) };
}

function ownerAlive(directory) {
  const owner = readJson(path.join(directory, "run.json"), null);
  if (!owner) return false;
  if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.startedAt) ||
      (owner.stoppedAt !== undefined && !Number.isFinite(owner.stoppedAt))) throw new Error("运行状态无效");
  if (owner.stoppedAt) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export class RunMaintenance {
  constructor({ root, runtime, sessions, log = () => {}, policy = RUN_RETENTION, inspectOpenPaths = openPaths }) {
    if (!(policy.maxAgeMs > 0) || !Number.isInteger(policy.keep) || policy.keep < 1 ||
        !Number.isInteger(policy.intervalMs) || policy.intervalMs < 1 || policy.intervalMs > 2147483647) throw new Error("运行缓存保留规则无效。");
    Object.assign(this, { root, runtime, sessions, log, policy, inspectOpenPaths });
  }
  protected(directory) {
    return this.closed || directory === (this.runtime?.runDir || this.runtime?.workspace) || directory === this.runtime?.workspaceDir || this.sessions?.loading.size > 0 ||
      [...(this.sessions?.sessions.values() || [])].some(session => path.resolve(session.cwd) === directory);
  }
  async start() {
    await this.sweep();
    if (this.closed) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.policy.intervalMs);
    this.timer.unref();
  }
  sweep({ now = Date.now(), dryRun = false } = {}) {
    // 同一时刻只做一轮维护；失败只影响清理，不中断聊天服务。
    if (this.closed) return Promise.resolve({ removed: [], bytes: 0 });
    this.running ||= this.prune(now, dryRun).catch(error => {
      if (this.lastError !== error.message) this.log(`缓存清理已跳过：${error.message}`);
      this.lastError = error.message;
      return { removed: [], bytes: 0, error: error.message };
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async prune(now, dryRun) {
    const runs = path.resolve(this.root, ".runs"), result = { removed: [], bytes: 0, skipped: [] };
    let info;
    try { info = fs.lstatSync(runs); } catch (error) { if (error.code === "ENOENT") return result; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(".runs 不是普通目录。");
    const candidates = [];
    for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_NAME.test(entry.name)) continue;
      const directory = path.join(runs, entry.name);
      try { candidates.push({ directory, ...inspectCache(directory) }); }
      catch { result.skipped.push(entry.name); }
    }
    candidates.sort((a, b) => b.modified - a.modified || a.directory.localeCompare(b.directory));
    const old = candidates.slice(this.policy.keep).filter(item => item.modified < now - this.policy.maxAgeMs && !this.protected(item.directory));
    if (!old.length) return result;
    const opened = await this.inspectOpenPaths(runs);
    for (const item of old) {
      const { directory } = item;
      try {
        if (this.protected(directory) || ownerAlive(directory) || opened.some(file => file === directory || file.startsWith(directory + path.sep))) continue;
        if (dryRun) { result.removed.push(path.basename(directory)); result.bytes += item.bytes; continue; }
        await rememberRunHistory(this.root, directory, this.runtime?.workspaceDir);
        // await 期间可能恢复了会话或写入了文件。删除前再次核验，不跨 await 做删除。
        if (this.protected(directory) || ownerAlive(directory) || inspectCache(directory).stamp !== item.stamp) continue;
        fs.rmSync(directory, { recursive: true });
        result.removed.push(path.basename(directory)); result.bytes += item.bytes;
      } catch (error) {
        result.skipped.push(path.basename(directory));
        this.log(`缓存目录 ${path.basename(directory)} 已保留：${error.message}`);
      }
    }
    this.lastError = null;
    if (result.removed.length && !dryRun) this.log(`缓存清理：删除 ${result.removed.length} 个旧运行目录，释放 ${(result.bytes / 1024 / 1024).toFixed(2)} MiB；会话索引已保留。`);
    return result;
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.running; }
}
