import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactLocalPaths } from "./research-protocol/redact.mjs";

test("研究协议结果写出前，本机临时目录与主目录换成占位符", t => {
  // 用真实目录和指向它的符号链接，模拟 macOS 上 /var/folders → /private/var/folders。
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "redact-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const realTmp = path.join(base, "private/var/T"), linkTmp = path.join(base, "var");
  fs.mkdirSync(realTmp, { recursive: true });
  fs.symlinkSync(path.join(base, "private/var"), linkTmp);
  const tmp = path.join(linkTmp, "T"), home = path.join(base, "home/alice");
  const raw = JSON.stringify({ cwd: `${realTmp}/run-1/work`, skill: `${tmp}/run-1/home/SKILL.md`, config: `${home}/.codex/config.toml`, other: "/opt/app" });
  const out = JSON.parse(redactLocalPaths(raw, { tmp, home }));
  assert.deepEqual(out, { cwd: "$TMPDIR/run-1/work", skill: "$TMPDIR/run-1/home/SKILL.md", config: "~/.codex/config.toml", other: "/opt/app" });
});
