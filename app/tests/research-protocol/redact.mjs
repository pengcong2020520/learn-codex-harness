// 研究协议的结果文件会提交进仓库：写出前把本机临时目录和主目录换成占位符，不泄露用户名和机器路径。
import fs from "node:fs";
import os from "node:os";

export function redactLocalPaths(text, { tmp = os.tmpdir(), home = os.homedir() } = {}) {
  const real = dir => { try { return fs.realpathSync(dir); } catch { return dir; } };
  // macOS 的 /var/folders 是 /private/var/folders 的符号链接，两种写法都要换；先换更长的，避免只换掉一半。
  return [[real(tmp), "$TMPDIR"], [tmp, "$TMPDIR"], [real(home), "~"], [home, "~"]]
    .filter(([dir]) => dir && dir.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((out, [dir, label]) => out.split(dir).join(label), text);
}
