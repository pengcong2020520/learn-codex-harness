import fs from "node:fs";

// 角色正文是 Agent 定义目录里的一个独立文本文件；路径由 Agent 定义的 agent.instructions 指定。
export function loadRole(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024) throw new Error("角色必须是小于 128 KiB 的独立文本文件。");
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) throw new Error("角色指令不能为空。");
  return text;
}
