import fs from "node:fs";
import path from "node:path";
import { loadEnvironment } from "../server/modules/config/index.mjs";
import { selectAgentFile } from "../server/modules/agents/selection.mjs";
import { validateDefinition } from "../server/modules/agents/schema.mjs";
import {
  resourcePath,
  validateKnowledgeBindings,
} from "../server/modules/data/paths.mjs";
import { PROJECT_ROOT } from "../shared/paths.mjs";
import {
  resolveWorkspace,
  assertWorkspaceLocation,
} from "../server/modules/codex/runtime.mjs";
function directory(target) {
  if (!fs.existsSync(target)) {
    directory(path.dirname(target));
    fs.mkdirSync(target, { mode: 0o700 });
  }
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("目录不能是文件或链接。");
}
try {
  const env = loadEnvironment(),
    file = selectAgentFile(PROJECT_ROOT, env.AGENT_DEFINITION),
    d = validateDefinition(JSON.parse(fs.readFileSync(file)));
  const workspace = path.resolve(path.dirname(file), d.bindings.workspaceDir);
  const roots = [
    ...Object.values(d.bindings.sources).map((s) => s.root),
    d.agent.outputs.directory,
    ...Object.values(
      validateKnowledgeBindings(d.bindings.knowledgeBases),
    ).flatMap((k) => [k.sourceRoot, k.wikiRoot]),
  ];
  roots.forEach(resourcePath);
  // Validate the eventual physical workspace before creating any directory.
  let ancestor = workspace;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  assertWorkspaceLocation(
    fs.realpathSync(PROJECT_ROOT),
    path.resolve(fs.realpathSync(ancestor), ...suffix),
  );
  directory(workspace);
  await resolveWorkspace(PROJECT_ROOT, workspace);
  for (const root of roots) {
    let target = workspace;
    for (const part of root.split("/")) {
      target = path.join(target, part);
      directory(target);
    }
  }
  console.log(
    `已准备 ${new Set(roots).size} 个配置目录；未覆盖任何文件。运行 npm run check 检查配置。`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
