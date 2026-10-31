import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
export const SUPPORTED_CODEX = Object.freeze(["0.154.0"]);
// Native conversation helpers observed in the 0.154.0 Responses payload.
export const NATIVE_TOOL_BASELINE = Object.freeze([
  "request_user_input",
  "get_goal",
  "create_goal",
  "update_goal",
]);
export const RESTRICTED_FEATURES = Object.freeze([
  "shell_tool",
  "view_image",
  "image_generation",
  "multi_agent",
  "apps",
  "hooks",
  "plugins",
]);
export function requireSupportedVersion(version) {
  if (!SUPPORTED_CODEX.includes(version))
    throw new Error(
      `Codex ${version} 未通过本脚手架协议验收；已验证版本：${SUPPORTED_CODEX.join(", ")}。请先运行 test:protocol，不会尝试修改旧会话。`,
    );
  return version;
}
export function installedCodex() {
  const require = createRequire(import.meta.url),
    pkg = require("@openai/codex/package.json");
  const cli = path.join(
    path.dirname(require.resolve("@openai/codex/package.json")),
    "bin/codex.js",
  );
  requireSupportedVersion(pkg.version);
  const actual = execFileSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    timeout: 10000,
  })
    .trim()
    .match(/^codex-cli (\S+)$/)?.[1];
  if (actual !== pkg.version)
    throw new Error("Codex 包与实际二进制版本不一致，拒绝启动。");
  return { cli, version: actual };
}
export async function verifyRestrictedFeatures(rpc) {
  const features = [],
    seen = new Set();
  let cursor;
  do {
    const page = await rpc.request("experimentalFeature/list", {
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    features.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Codex 功能分页游标重复。");
    seen.add(cursor);
  } while (cursor);
  for (const name of RESTRICTED_FEATURES) {
    const feature = features.find((value) => value.name === name);
    if (!feature || feature.enabled !== false || feature.stage === "removed")
      throw new Error(`Codex 原生能力 ${name} 未被有效关闭，拒绝启动。`);
  }
  return {
    version: rpc.version,
    restrictedFeatures: RESTRICTED_FEATURES,
    verified: true,
  };
}
