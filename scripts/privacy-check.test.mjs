import test from "node:test";
import assert from "node:assert/strict";
import { findPrivacyIssues } from "./privacy-check.mjs";

const rulesOf = text => findPrivacyIssues(text).map(issue => issue.rule);
// 样例都写在模板里拼出来，避免本文件自己被隐私检查拦下。
const at = "@";

test("拦下本机路径、个人邮箱、公网 IP、私钥与访问令牌", () => {
  const cases = [
    [`cd /Us${"ers"}/alice/project`, "本机用户目录"],
    [`见 /ho${"me"}/alice/.bashrc`, "本机用户目录"],
    [`"cwd": "/private/var/fol${"ders"}/1t/abc123xyz/T/run-1"`, "macOS 临时目录"],
    [`联系 someone${at}gmail.com`, "邮箱"],
    [`Co-authored-by: me <me${at}company.cn>`, "邮箱"],
    [`ssh root${at}${[47, 85, 1, 2].join(".")}`, "公网 IP"],
    [`-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`, "私钥"],
    [`CODEX_API_KEY=sk-${"a".repeat(32)}`, "访问令牌"],
    [`token gh${"p"}_${"A".repeat(36)}`, "访问令牌"],
  ];
  for (const [text, rule] of cases) assert.deepEqual(rulesOf(text), [rule], text);
});

test("放行示例地址、保留网段、占位路径与测试假值", () => {
  for (const text of [
    `p${at}example.com 与 pass${at}provider.invalid`,
    `pengcong2020520 <65808592+pengcong2020520${at}users.noreply.github.com>`,
    `Co-Authored-By: Claude <noreply${at}anthropic.com>`,
    "监听 127.0.0.1:4317；文档网段 203.0.113.9、198.51.100.7；元数据 169.254.169.254",
    "DEPLOY_HOST=root@1.2.3.4",
    `"path": "$TMPDIR/harness-run/home/.agents/skills/a/SKILL.md"`,
    "CODEX_API_KEY=sk-test-secret-key-1234567890",
    "版本 0.154.0、v24.11.0、1.2.3",
  ]) assert.deepEqual(findPrivacyIssues(text), [], text);
});

test("行内写 privacy-check: allow 的示例行不报", () => {
  const line = `仅示例：someone${at}gmail.com`;
  assert.equal(findPrivacyIssues(line).length, 1);
  assert.equal(findPrivacyIssues(`${line} <!-- privacy-check: allow -->`).length, 0);
  assert.deepEqual(findPrivacyIssues(`第一行\n第二行 someone${at}gmail.com`).map(issue => issue.line), [2]);
});
