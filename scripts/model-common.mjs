// 根目录配置工具的共享逻辑；不加载阶段模块，不读取凭证内容。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const DIRECT_KEYS = ["CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL"];
export class SetupError extends Error {}
export const fail = message => { throw new SetupError(message); };
export function safeError(error) {
  // 系统错误和子进程输出可能含路径、环境或密钥，绝不直接转发。
  return error instanceof SetupError ? error.message : "操作失败；请检查文件权限、依赖安装和终端环境（原始错误已隐藏）。";
}
export function readText(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function stages(root = ROOT) {
  return fs.readdirSync(path.join(root, "stages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^s\d{2}-/.test(entry.name))
    .map(entry => ({ id: entry.name.slice(0, 3), relative: `stages/${entry.name}`, dir: path.join(root, "stages", entry.name) }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .concat({ id: "app", relative: "app", dir: path.join(root, "app") });
}
// s11、s12、s13、s14、s15、s16、s17 与 app 使用模型网关，不进入 link-login 默认列表。
export const loginStages = all => all.filter(stage => /^s(0[1-9]|10)$/.test(stage.id));
export const gatewayStage = stage => ["s11", "s12", "s13", "s14", "s15", "s16", "s17", "app"].includes(stage.id);
export function selectStages(all, selectors, defaults = all) {
  if (!selectors?.length) return defaults;
  const selected = selectors.flatMap(value => value.split(/[\s,]+/)).filter(Boolean).map(value => {
    const stage = all.find(item => item.id === value || item.relative === value || path.basename(item.dir) === value);
    if (!stage) fail("阶段参数无效；请使用 s00–s17 或 app，可用逗号分隔。");
    return stage;
  });
  return [...new Set(selected)];
}
export function parseArgs(argv, allowed) {
  const result = { selectors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stage") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) fail("--stage 后需要阶段名称。");
      result.selectors.push(argv[++i]);
    } else if (allowed.includes(arg)) result[arg.slice(2)] = true;
    else if (arg.startsWith("-")) fail("不支持的参数；使用 --help 查看用法。");
    else result.selectors.push(arg);
  }
  return result;
}
export function envFor(stage, inherited = {}) {
  const text = readText(path.join(stage.dir, ".env"));
  return { exists: text !== null, values: { ...parseEnv(text || ""), ...inherited } };
}

function encodeValue(value) {
  const text = String(value);
  if (/[\r\n\x00-\x1f\x7f]/.test(text)) fail("配置值不能包含换行或控制字符。");
  if (/^[A-Za-z0-9_./:@+,%?=&~-]*$/.test(text)) return text;
  // node:util.parseEnv 不做变量替换；选用不出现在内容中的引号。
  for (const quote of ["'", '"', "`"]) if (!text.includes(quote)) return quote + text + quote;
  fail("配置值包含无法安全写入 .env 的引号组合。");
}

export function editEnv(text, updates = {}, commentKeys = []) {
  const seen = new Set();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // 以原始行片段处理，未命中行（含换行符）逐字保留。
  let edited = text.replace(/[^\r\n]*(?:\r\n|\n|$)/g, line => {
    const match = line.match(/^(\s*)(?:export\s+)?([A-Za-z_][\w]*)\s*=(.*?)(\r?\n)?$/);
    if (!match) return line;
    const [, indent, key, rest, ending = ""] = match;
    if (commentKeys.includes(key)) return `# ${line}`;
    if (!Object.hasOwn(updates, key)) return line;
    seen.add(key);
    // 保留值后面的行内注释；引号内部的 # 不算注释。
    let quote = null;
    let comment = "";
    for (let i = 0; i < rest.length; i++) {
      if (quote) { if (rest[i] === quote) quote = null; }
      else if (["'", '"', "`"].includes(rest[i])) quote = rest[i];
      else if (rest[i] === "#") { comment = " " + rest.slice(i); break; }
    }
    return `${indent}${key}=${encodeValue(updates[key])}${comment}${ending}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (edited && !edited.endsWith("\n")) edited += eol;
    edited += `${key}=${encodeValue(value)}${eol}`;
  }
  return edited;
}
export function writeEnv(stage, updates = {}, commentKeys = []) {
  const file = path.join(stage.dir, ".env");
  const stat = lstat(file);
  if (stat && !stat.isFile()) fail(".env 必须是普通文件；不会沿符号链接写入。");
  const source = readText(file) ?? readText(path.join(stage.dir, ".env.example"));
  if (source === null) fail("缺少 .env.example，无法创建配置。");
  const content = editEnv(source, updates, commentKeys);
  const temporary = path.join(stage.dir, `.env.setup-${randomBytes(8).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function classify(values, exists = true, stage = {}) {
  if (gatewayStage(stage)) {
    const missing = [];
    if (!values.AGENT_GATEWAY_KEY?.trim()) missing.push("AGENT_GATEWAY_KEY（请运行 npm run setup:model，选择路线 C）");
    if (values.CODEX_API_KEY?.trim() || values.CODEX_BASE_URL?.trim()) missing.push("移除直连 CODEX_API_KEY / CODEX_BASE_URL");
    return { mode: "API Key（模型网关）", kind: "gateway", missing };
  }
  if (stage.id === "s00") return { mode: values.CODEX_API_KEY?.trim() ? "API Key" : "已有登录", kind: values.CODEX_API_KEY?.trim() ? "api" : "login", missing: [] };
  // 空的 KEY/URL 仍会让现有阶段进入 API 分支。
  if (DIRECT_KEYS.some(key => Object.hasOwn(values, key))) {
    return { mode: "API Key", kind: "api", missing: DIRECT_KEYS.filter(key => !values[key]?.trim()) };
  }
  const missing = exists ? [] : [".env"];
  // 已有登录没有模型名；本地目录开关不是 false 时，目录生成器会报缺模型名。s00 已在上面返回。
  if (exists && stage.id && values.CODEX_MODEL_CATALOG_ENABLED?.trim() !== "false") missing.push("设 CODEX_MODEL_CATALOG_ENABLED=false");
  return { mode: exists ? "已有登录" : "未配置", kind: "login", missing };
}
export function validateBaseUrl(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) return "Base URL 不能含控制字符。";
  let url;
  try { url = new URL(value); } catch { return "填写完整的 CODEX_BASE_URL。"; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "使用 HTTPS；仅回环地址允许 HTTP。";
  if (url.username || url.password || url.search || url.hash) return "Base URL 不能含账号、密码、查询参数或片段。";
  if (/\/(responses|chat\/completions)\/*$/i.test(url.pathname)) return "移除 Base URL 末尾的 /responses 或 /chat/completions。";
  return null;
}
export function providers(root = ROOT) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "app/config/models.json"), "utf8"));
  const sdk = parseEnv((readText(path.join(root, "stages/s00-sdk-quickstart/.env.example")) || "").replace(/^#\s*(CODEX_\w+=)/gm, "$1"));
  const example = parseEnv(readText(path.join(root, "stages/s01-single-turn/.env.example")) || "");
  return [["openai", "OpenAI", sdk.CODEX_BASE_URL], ["kimi", "Kimi", catalog.providers.kimi?.baseUrl], ["deepseek", "DeepSeek", example.CODEX_BASE_URL]]
    .map(([id, name, baseUrl]) => {
      const fullModel = [...(catalog.routes.chat || []), ...Object.keys(catalog.models)].find(model => model.startsWith(id + "/") && catalog.models[model]?.purposes?.includes("chat"));
      return { id, name, baseUrl, model: id === "deepseek" ? example.CODEX_MODEL : fullModel?.slice(id.length + 1) };
    }).filter(item => item.baseUrl && item.model);
}
export function gatewayKeys(root = ROOT) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "app/config/models.json"), "utf8"));
  return [...new Set(Object.values(catalog.providers).map(item => item.keyEnv).filter(Boolean))];
}
export const generateGatewayKey = () => `sk-bf-${randomBytes(32).toString("hex")}`;
export const localAuthPath = (env = process.env, home = os.homedir()) => path.resolve(env.CODEX_HOME || path.join(home, ".codex"), "auth.json");
export const stageHome = stage => path.join(stage.dir, ".data", "codex");
export function lstat(file, options) { try { return fs.lstatSync(file, options); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
export function linkState(stage, target) {
  const file = path.join(stageHome(stage), "auth.json");
  const stat = lstat(file);
  if (!stat) return "缺少链接";
  if (!stat.isSymbolicLink()) return "普通文件或目录";
  if (path.resolve(path.dirname(file), fs.readlinkSync(file)) !== path.resolve(target)) return "链接目标不符";
  const targetStat = lstat(target);
  if (!targetStat) return "链接失效（本机凭证不存在）";
  return targetStat.isFile() ? "链接正确" : "链接目标不是普通文件";
}
export function linkAuth(stage, target, { now = () => Date.now(), symlink = fs.symlinkSync } = {}) {
  target = path.resolve(target);
  const targetStat = lstat(target, { bigint: true });
  if (!targetStat?.isFile()) fail("本机凭证必须是普通文件，不能是符号链接；请重新 npx codex login。");
  // 规范化 Codex 目录本身（允许 HOME 的目录别名），但 auth.json 不得解析到目录之外。
  const expectedDirectory = fs.realpathSync(path.dirname(target));
  const resolvedTarget = fs.realpathSync(target);
  if (path.dirname(resolvedTarget) !== expectedDirectory) fail("本机凭证必须位于预期的 Codex 目录内。");
  const file = path.join(stageHome(stage), "auth.json");
  const destination = lstat(file, { bigint: true });
  if (resolvedTarget === path.resolve(file) || (destination && targetStat.dev === destination.dev && targetStat.ino === destination.ino)) {
    fail("本机凭证不能是将被替换的 auth.json（包括同 inode 的硬链接或目录别名）。");
  }
  for (const directory of [path.join(stage.dir, ".data"), stageHome(stage)]) {
    const stat = lstat(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail("阶段状态目录必须是真实目录。");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  if (linkState(stage, target) === "链接正确") return "已有正确链接，跳过";
  const stat = lstat(file);
  if (stat && !stat.isFile() && !stat.isSymbolicLink()) fail("auth.json 不是文件或符号链接，请手工检查。");
  // 先创建新链接，Windows 权限失败时不移动现有凭证。
  const temporary = `${file}.link-${randomBytes(8).toString("hex")}`;
  let backup;
  try {
    symlink(target, temporary, "file");
    if (stat?.isFile()) {
      backup = `${file}.bak-${now()}`;
      while (lstat(backup)) backup += "-1";
      fs.renameSync(file, backup);
      fs.chmodSync(backup, 0o600);
    } else if (stat?.isSymbolicLink()) fs.unlinkSync(file);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (backup && !lstat(file)) fs.renameSync(backup, file);
    if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) fail("无法创建符号链接；Windows 请启用开发者模式或改用 API Key 路线，不会复制凭证。");
    throw error;
  } finally { if (lstat(temporary)) fs.unlinkSync(temporary); }
  return backup ? `已链接；原普通文件已备份为 ${path.basename(backup)}` : "已创建链接";
}
export function unlinkAuth(stage) {
  const file = path.join(stageHome(stage), "auth.json");
  // 不穿过符号链接目录，绝不触及其他目录中的真实凭证。
  if ([path.join(stage.dir, ".data"), stageHome(stage)].some(dir => lstat(dir)?.isSymbolicLink())) return "跳过：状态目录为符号链接";
  if (!lstat(file)?.isSymbolicLink()) return "跳过：不是符号链接";
  fs.unlinkSync(file);
  return "已删除链接（本机凭证保留）";
}
export function codexPath(stage) {
  // 根工具统一使用 stages 下已安装的 CLI；app 的检查借用同版本 s11 CLI。
  const directory = stage.id === "app" ? path.resolve(stage.dir, "../stages/s11-model-gateway") : stage.dir;
  return path.join(directory, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
}
export function findCodex(all) {
  const found = all.filter(stage => stage.id !== "app").map(codexPath).find(file => fs.existsSync(file));
  if (!found) fail("未找到阶段 Codex；请先运行 npm --prefix stages/s01-single-turn ci。");
  return found;
}
export function cleanLoginEnv(env, home) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) || DIRECT_KEYS.includes(key)) delete result[key];
  if (home) result.CODEX_HOME = home;
  // 本机调用保留用户已有 CODEX_HOME，不额外设置隔离目录。
  return result;
}
export const isMain = url => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);
