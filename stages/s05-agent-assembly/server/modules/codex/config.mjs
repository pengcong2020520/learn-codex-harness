import fs from "node:fs";
import path from "node:path";
import { writeText } from "../storage/index.mjs";

const HEADER = "# project-managed Codex configuration";

export function codexPaths(root) {
  const home = path.join(root, ".data", "codex");
  return { home, configFile: path.join(home, "config.toml") };
}

// 公共状态位置与配置只有这一处负责；原生历史写在本服务自己的 .data/codex，不碰个人目录。
export function prepareCodexConfig(config) {
  const paths = codexPaths(config.root);
  for (const directory of [path.join(config.root, ".data"), paths.home]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codex 状态目录不能是符号链接或普通文件。");
  }
  try {
    const stat = fs.lstatSync(paths.configFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Codex 配置必须是独立普通文件。");
    const previous = fs.readFileSync(paths.configFile, "utf8");
    if (!previous.startsWith(HEADER + "\n")) {
      throw new Error(".data/codex/config.toml 不是本项目生成的配置；为保护文件已停止启动。");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const table = (name, entries) => `[${name}]\n` + Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n") + "\n";
  // 本阶段不开启原生记忆。
  const content = `${HEADER}\nsqlite_home = ${JSON.stringify(paths.home)}\n` + table("features", { memories: false });
  writeText(paths.configFile, content);
  config.launch.env = { ...config.launch.env, CODEX_HOME: paths.home, CODEX_SQLITE_HOME: paths.home };
  return paths;
}
