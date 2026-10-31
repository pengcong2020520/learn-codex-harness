// 每次启动生成私有运行目录和模型目录；不改变已有 Codex 历史存储位置。
import { mkdir, mkdtemp, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../../../shared/paths.mjs";
import { readJson, writeJson } from "../storage/index.mjs";

export const RUN_NAME = /^app-server-[a-zA-Z0-9_-]+$/;

export function finishRun(workspace) {
  const file = path.join(workspace, "run.json");
  const state = readJson(file, null);
  if (state?.pid === process.pid && !state.stoppedAt) writeJson(file, { ...state, stoppedAt: Date.now() });
}

export function assertWorkspaceLocation(serviceRoot, physical) {
  if (physical === serviceRoot || [".runs", ".data", "server", "client", "agents", "config"].some(name => physical === path.join(serviceRoot, name) || physical.startsWith(path.join(serviceRoot, name) + path.sep))) throw new Error("不能把服务代码、配置或运行状态目录作为工作区。");
  if (serviceRoot.startsWith(physical + path.sep)) throw new Error("工作区不能包含服务目录：Agent 配置与运行状态会落进用户数据的范围。");
}

export async function resolveWorkspace(root, requested = path.join(root, "workspace")) {
  const target = path.resolve(requested), fallback = path.resolve(root, "workspace");
  if (target === fallback) await mkdir(target, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(target); } catch (error) { if (error.code === "ENOENT") throw new Error(`工作区不存在：${target}。请创建/恢复目录或修正 Agent 绑定。`); throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("工作区必须是真实目录，不能是符号链接。");
  const physical = await realpath(target), serviceRoot = await realpath(root);
  assertWorkspaceLocation(serviceRoot, physical);
  return physical;
}

export async function prepareRun(launch, root = PROJECT_ROOT, { workspaceDir, instructions } = {}) {
  const stableWorkspace = await resolveWorkspace(root, workspaceDir);
  const runs = path.resolve(root, ".runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(path.join(runs, "app-server-"));
  writeJson(path.join(workspace, "run.json"), { version: 1, pid: process.pid, startedAt: Date.now() });
  const args = [...launch.args];
  let catalogFile = null;
  if (launch.catalog) {
    catalogFile = path.join(workspace, "models.json");
    const catalog = structuredClone(launch.catalog);
    if (instructions !== undefined) for (const model of catalog.models) model.model_messages = { instructions_template: instructions };
    await writeFile(catalogFile, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    args.push("-c", `model_catalog_json=${JSON.stringify(catalogFile)}`);
  }
  // workspace 只为旧 05 单文件示例保留别名；正式服务不再使用该含糊字段。
  return { serviceRoot: path.resolve(root), workspaceDir: stableWorkspace, runDir: workspace, codexHome: path.join(root, ".data/codex"), workspace, args, catalogFile };
}
