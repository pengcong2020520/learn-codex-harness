import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`无法读取状态文件 ${path.basename(file)}；为保护已有数据，已停止启动。`); }
}

export function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

export function writeText(file, content) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// 一个 project 只允许一个调度服务写状态；旧锁只在确认进程已退出后清理。
export function acquireServerLock(root) {
  const file = path.join(root, ".data", "server.lock");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const info = lstatSync(path.dirname(file));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('状态目录不能是符号链接。');
  const value = { pid: process.pid, instance: randomUUID() };
  const create = () => writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try { create(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = readJson(file);
    if (!Number.isInteger(old?.pid) || old.pid < 1) throw new Error("服务锁文件无效，请先检查 .data/server.lock。");
    let alive = true;
    try { process.kill(old.pid, 0); } catch (failure) { if (failure.code === "ESRCH") alive = false; }
    if (alive) throw new Error("本项目已有 Agent 服务运行，请连接现有服务，不要重复启动。");
    unlinkSync(file);
    create();
  }
  return () => { if (readJson(file, null)?.instance === value.instance) unlinkSync(file); };
}
