// 隐私检查：扫描所有已跟踪文件，发现本机路径、个人邮箱、公网 IP、密钥就失败。
// 本仓库公开发布，这道检查在 CI 和根目录 npm test 中运行。确属示例的行，在行内写 privacy-check: allow 放行。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 文档与测试里故意使用的地址：示例域名、保留网段、云厂商元数据地址等。
const allowedEmailDomains = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost|users\.noreply\.github\.com)$/i;
const allowedEmails = new Set(["noreply@anthropic.com", "noreply@github.com"]);
const allowedIps = new Set(["1.2.3.4", "93.184.216.34", "168.63.129.16"]);
const reservedIp = /^(0|10|127)\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.0\.[02]\.|^192\.88\.99\.|^192\.168\.|^198\.(1[89])\.|^198\.51\.100\.|^203\.0\.113\.|^(22[4-9]|2[3-5]\d)\./;

const rules = [
  { name: "本机用户目录", pattern: /\/Users\/(?!Shared\/)[A-Za-z0-9._-]+|\/home\/(?!runner\b)[a-z_][a-z0-9_-]*\/|[A-Za-z]:\\\\?Users\\\\?[^\\\s"']+/g },
  { name: "macOS 临时目录", pattern: /\/var\/folders\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g },
  { name: "邮箱", pattern: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g,
    ignore: (match, domain) => allowedEmails.has(match.toLowerCase()) || allowedEmailDomains.test(domain) },
  { name: "公网 IP", pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g,
    ignore: match => allowedIps.has(match) || reservedIp.test(match) || match.split(".").some(part => Number(part) > 255) },
  { name: "私钥", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "访问令牌", pattern: /\b(?:sk-(?!test|fake|dummy|example)[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|LTAI[0-9A-Za-z]{12,}|xox[abprs]-[A-Za-z0-9-]{10,})/g },
];

export function findPrivacyIssues(text) {
  const issues = [];
  text.split("\n").forEach((line, index) => {
    if (line.includes("privacy-check: allow")) return;
    for (const rule of rules) {
      for (const match of line.matchAll(rule.pattern)) {
        if (rule.ignore?.(match[0], match[1])) continue;
        issues.push({ line: index + 1, rule: rule.name, match: match[0] });
      }
    }
  });
  return issues;
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const problems = [];
  for (const file of trackedFiles(root)) {
    // 依赖锁文件只含 npm 仓库地址与哈希。
    if (file.endsWith("package-lock.json")) continue;
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) continue;
    for (const issue of findPrivacyIssues(buffer.toString("utf8"))) problems.push(`${file}:${issue.line}  ${issue.rule}  ${issue.match}`);
  }
  if (problems.length) {
    console.error(`发现 ${problems.length} 处可能泄露隐私的内容：\n${problems.join("\n")}\n确属示例的行可加注释 privacy-check: allow。`);
    process.exit(1);
  }
  console.log("隐私检查通过：没有本机路径、个人邮箱、公网 IP 或密钥。");
}
