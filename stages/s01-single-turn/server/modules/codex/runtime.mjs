// 每次启动生成私有运行目录和模型目录；不改变已有 Codex 历史存储位置。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../../../shared/paths.mjs";
import { readJson, writeJson } from "../storage/index.mjs";

export const RUN_NAME = /^app-server-[a-zA-Z0-9_-]+$/;

export function finishRun(workspace) {
  const file = path.join(workspace, "run.json");
  const state = readJson(file, null);
  if (state?.pid === process.pid && !state.stoppedAt) writeJson(file, { ...state, stoppedAt: Date.now() });
}

export async function prepareRun(launch, root = PROJECT_ROOT) {
  const runs = path.resolve(root, ".runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(path.join(runs, "app-server-"));
  writeJson(path.join(workspace, "run.json"), { version: 1, pid: process.pid, startedAt: Date.now() });
  const args = [...launch.args];
  let catalogFile = null;
  if (launch.catalog) {
    catalogFile = path.join(workspace, "models.json");
    await writeFile(catalogFile, JSON.stringify(launch.catalog, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    args.push("-c", `model_catalog_json=${JSON.stringify(catalogFile)}`);
  }
  return { workspace, args, catalogFile };
}
