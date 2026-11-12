import fs from 'node:fs';
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
export const SUPPORTED_CODEX = Object.freeze(["0.154.0"]);
// Native conversation helpers observed in the 0.154.0 Responses payload.
// 目标工具（create/get/update_goal）随 features.goals 一起关闭。
export const NATIVE_TOOL_BASELINE = Object.freeze(["request_user_input"]);
export const RESTRICTED_FEATURES = Object.freeze([
  "shell_tool",
  "view_image",
  "image_generation",
  "multi_agent",
  "apps",
  "hooks",
  "plugins",
  "goals",
]);
// 不是功能开关、需要通过 config/read 核对生效值的限制。
export const RESTRICTED_CONFIG = Object.freeze({ project_doc_max_bytes: 0 });
export function requireSupportedVersion(version) {
  if (!SUPPORTED_CODEX.includes(version))
    throw new Error(
      `Codex ${version} 未通过本脚手架协议验收；已验证版本：${SUPPORTED_CODEX.join(", ")}。请先运行 test:protocol，不会尝试修改旧会话。`,
    );
  return version;
}
export function installedCodex({ env, cwd, uid, gid } = {}) {
  const require = createRequire(import.meta.url),
    pkg = require("@openai/codex/package.json");
  const cli = path.join(
    path.dirname(require.resolve("@openai/codex/package.json")),
    "bin/codex.js",
  );
  requireSupportedVersion(pkg.version);
  // 读取已安装官方平台包里的原生可执行文件，不复制 CLI 启动器的实现。
  // 直接 exec 原生进程，避免 SIGKILL Node 包装器后遗留 App Server 孙进程。
  const platform = `@openai/codex-${process.platform}-${process.arch}`;
  const vendor = path.join(path.dirname(require.resolve(`${platform}/package.json`)), 'vendor');
  const binaries = fs.readdirSync(vendor).map(target => path.join(vendor, target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'))
    .filter(file => fs.existsSync(file));
  if (binaries.length !== 1) throw new Error('Codex 官方平台包中没有唯一的原生可执行文件。');
  const executable = binaries[0];
  const actual = execFileSync(executable, ["--version"], {
    env, cwd, uid, gid,
    encoding: "utf8",
    timeout: 10000,
  })
    .trim()
    .match(/^codex-cli (\S+)$/)?.[1];
  if (actual !== pkg.version)
    throw new Error("Codex 包与实际二进制版本不一致，拒绝启动。");
  return { cli, executable, version: actual };
}
export async function verifyRestrictedFeatures(rpc, cwd = null) {
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
  // 按工作区读取：项目层配置也不能把限制改回去。
  const { config } = await rpc.request("config/read", { cwd });
  for (const [key, value] of Object.entries(RESTRICTED_CONFIG))
    if (config?.[key] !== value)
      throw new Error(`Codex 配置 ${key} 未生效为 ${value}，拒绝启动。`);
  return {
    version: rpc.version,
    restrictedFeatures: RESTRICTED_FEATURES,
    restrictedConfig: RESTRICTED_CONFIG,
    verified: true,
  };
}
