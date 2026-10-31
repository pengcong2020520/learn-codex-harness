import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROLE = fileURLToPath(new URL("../../../agents/roles/writing-assistant.md", import.meta.url));
export function loadRole(file = DEFAULT_ROLE) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024) throw new Error("角色必须是小于 128 KiB 的独立文本文件。");
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) throw new Error("角色指令不能为空。");
  return text;
}
