import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { parseEnv } from "node:util";
import {
  ROOT, DIRECT_KEYS, stages, editEnv, writeEnv, classify, providers, envFor,
  validateBaseUrl, localAuthPath, linkAuth, linkState, unlinkAuth, stageHome,
  generateGatewayKey, cleanLoginEnv, codexPath, selectStages, loginStages,
} from "../model-common.mjs";
import { askTerminal, loginStatus, handshake, runProcess } from "../model-io.mjs";
import { main as setup, minimalValidation, startCommands } from "../setup-model.mjs";
import { main as link } from "../link-login.mjs";
import { main as doctor } from "../doctor.mjs";

const secret = "sk-test-" + "private-value-".repeat(3);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-setup-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const stage of stages(ROOT)) {
    const dir = path.join(root, stage.relative);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(stage.dir, ".env.example"), path.join(dir, ".env.example"));
    fs.copyFileSync(path.join(stage.dir, "package.json"), path.join(dir, "package.json"));
  }
  fs.mkdirSync(path.join(root, "app/config"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "app/config/models.json"), path.join(root, "app/config/models.json"));
  const all = stages(root);
  const stage = all.find(item => item.id === "s01");
  fs.mkdirSync(path.dirname(codexPath(stage)), { recursive: true });
  fs.writeFileSync(codexPath(stage), "mock CLI; never executed");
  const home = path.join(root, "local-home");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const target = localAuthPath({}, home);
  fs.writeFileSync(target, "opaque fixture credential");
  const logs = [];
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { code: 0, output: "Logged in using ChatGPT" }; };
  const answers = [];
  const prompts = [];
  const ask = async (prompt, options) => {
    prompts.push({ prompt, options });
    assert.ok(answers.length > 0, "unexpected prompt");
    return answers.shift();
  };
  return { root, all, stage, home, target, logs, calls, answers, prompts, run, ask, env: {}, log: text => logs.push(text) };
}

test(".env 仅替换三项，保留注释、相似参数、空行、CRLF 和末尾状态", () => {
  const source = '# keep\r\nCODEX_API_KEY=old # key comment\r\nCODEX_BASE_URL="old#url" # url comment\r\nCODEX_MODEL=old\r\n\r\nCODEX_MODEL_CONTEXT_WINDOW=123\r\nOTHER="原样"';
  const result = editEnv(source, { CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com/v1", CODEX_MODEL: "chosen" });
  assert.equal(result, source.replace("=old #", `=${secret} #`).replace('="old#url"', "=https://example.com/v1").replace("CODEX_MODEL=old", "CODEX_MODEL=chosen"));
  assert.equal(parseEnv(result).CODEX_API_KEY, secret);
  assert.equal(editEnv("X=keep\n# CODEX_MODEL=comment\n", { CODEX_MODEL: "chosen" }), "X=keep\n# CODEX_MODEL=comment\nCODEX_MODEL=chosen\n");
});

test("带 #、空格的 Key 可 roundtrip；拒绝换行注入", () => {
  const value = "fake # value with space";
  assert.equal(parseEnv(editEnv("", { CODEX_API_KEY: value })).CODEX_API_KEY, value);
  assert.throws(() => editEnv("", { CODEX_API_KEY: "fake\nINJECT=1" }));
});

test("复制模板、0600 权限、重复写入不追加重复变量、拒绝 .env 符号链接", t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.stage.dir, ".env.example"), "utf8");
  const updates = { CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com", CODEX_MODEL: "chosen" };
  writeEnv(f.stage, updates);
  const file = path.join(f.stage.dir, ".env");
  assert.equal(fs.readFileSync(file, "utf8"), editEnv(before, updates));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeEnv(f.stage, updates);
  assert.equal(fs.readFileSync(file, "utf8"), editEnv(before, updates));
  fs.unlinkSync(file); fs.symlinkSync(f.target, file);
  assert.throws(() => writeEnv(f.stage, updates));
  assert.equal(fs.readFileSync(f.target, "utf8"), "opaque fixture credential");
});

test("注释三项（包括空值和重复行）时不改其余参数与既有注释", () => {
  const text = "# CODEX_MODEL=comment\nCODEX_API_KEY=\nexport CODEX_BASE_URL=https://example.com\n CODEX_MODEL=old\nCODEX_MODEL=duplicate\nCODEX_MODEL_CATALOG_ENABLED=true\n";
  const result = editEnv(text, {}, DIRECT_KEYS);
  assert.equal(result, "# CODEX_MODEL=comment\n# CODEX_API_KEY=\n# export CODEX_BASE_URL=https://example.com\n#  CODEX_MODEL=old\n# CODEX_MODEL=duplicate\nCODEX_MODEL_CATALOG_ENABLED=true\n");
  assert.deepEqual(parseEnv(result), { CODEX_MODEL_CATALOG_ENABLED: "true" });
});

test("模式判断：完整/部分/空项 API、已有登录、未配置、网关和 SDK", () => {
  assert.equal(classify({}, false).mode, "未配置");
  assert.equal(classify({}).mode, "已有登录");
  assert.deepEqual(classify({ CODEX_API_KEY: "" }).missing, DIRECT_KEYS);
  assert.deepEqual(classify({ CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com" }).missing, ["CODEX_MODEL"]);
  assert.equal(classify({ CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com", CODEX_MODEL: "test" }).missing.length, 0);
  assert.equal(classify({ AGENT_GATEWAY_KEY: secret }, true, { id: "s11" }).kind, "gateway");
  assert.equal(classify({ CODEX_API_KEY: secret }, false, { id: "s00" }).missing.length, 0);
  const login = { id: "s01" };
  assert.deepEqual(classify({ CODEX_MODEL_CATALOG_ENABLED: "false" }, true, login).missing, []);
  assert.deepEqual(classify({ CODEX_MODEL_CATALOG_ENABLED: " false " }, true, login).missing, []);
  for (const value of ["true", "yes", ""]) {
    assert.deepEqual(classify({ CODEX_MODEL_CATALOG_ENABLED: value }, true, login).missing, ["设 CODEX_MODEL_CATALOG_ENABLED=false"]);
  }
  assert.deepEqual(classify({}, true, login).missing, ["设 CODEX_MODEL_CATALOG_ENABLED=false"]);
  assert.deepEqual(classify({}, false, login).missing, [".env"]);
  assert.deepEqual(classify({ CODEX_MODEL_CATALOG_ENABLED: "true" }, true, { id: "s00" }).missing, []);
  assert.deepEqual(classify({ CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com", CODEX_MODEL: "test", CODEX_MODEL_CATALOG_ENABLED: "true" }, true, login).missing, []);
});

test("隐藏输入不回显，并恢复 raw 模式；支持删除和取消", async () => {
  const input = new PassThrough(); input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let output = "";
  const writer = { write: text => { output += text; } };
  const pending = askTerminal("Key：", { secret: true, input, output: writer });
  for (const char of secret) input.emit("keypress", char, {});
  input.emit("keypress", "x", {});
  input.emit("keypress", "", { name: "backspace" });
  input.emit("keypress", "\r", { name: "return" });
  assert.equal(await pending, secret);
  assert.equal(output, "Key：\n");
  assert.equal(input.isRaw, false);
  const cancelled = askTerminal("Key：", { secret: true, input, output: writer });
  input.emit("keypress", "", { name: "c", ctrl: true });
  await assert.rejects(cancelled);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(input.isRaw, false);
  input.destroy();
});

test("建链接：普通文件先备份、正确链接跳过、错误链接替换、不改本机文件", t => {
  const f = fixture(t);
  const file = path.join(stageHome(f.stage), "auth.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "previous credential");
  assert.match(linkAuth(f.stage, f.target, { now: () => 123 }), /auth.json.bak-123/);
  assert.equal(fs.readFileSync(file + ".bak-123", "utf8"), "previous credential");
  assert.equal(fs.readlinkSync(file), f.target);
  assert.equal(linkAuth(f.stage, f.target), "已有正确链接，跳过");
  assert.equal(fs.readFileSync(f.target, "utf8"), "opaque fixture credential");
  if (process.platform !== "win32") assert.equal(fs.statSync(stageHome(f.stage)).mode & 0o777, 0o700);
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.root, "missing"), file);
  assert.equal(linkState(f.stage, f.target), "链接目标不符");
  linkAuth(f.stage, f.target);
  assert.equal(linkState(f.stage, f.target), "链接正确");
});

test("不支持符号链接时明确失败，不复制或移动原凭证", t => {
  const f = fixture(t);
  const file = path.join(stageHome(f.stage), "auth.json");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "keep");
  assert.throws(() => linkAuth(f.stage, f.target, { symlink: () => { throw Object.assign(new Error(secret), { code: "EPERM" }); } }), /Windows.*API Key/);
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});

test("--unlink 只删链接，保留本机文件、普通文件和备份，不要求依赖", async t => {
  const f = fixture(t);
  linkAuth(f.stage, f.target);
  assert.equal(await link(["--stage", "s01", "--unlink"], f), 0);
  assert.equal(fs.existsSync(f.target), true);
  const file = path.join(stageHome(f.stage), "auth.json"); fs.writeFileSync(file, "keep");
  assert.match(unlinkAuth(f.stage), /跳过/);
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
  assert.equal(f.calls.length, 0);
});

test("链接状态和只读 --check；不创建 .env 或 .data", async t => {
  const f = fixture(t);
  assert.equal(await setup(["--check", "--stage", "s01"], f), 1);
  assert.match(f.logs.join("\n"), /s01 \| 未配置 \| .env \| 缺少链接/);
  assert.equal(fs.existsSync(path.join(f.stage.dir, ".env")), false);
  assert.equal(fs.existsSync(stageHome(f.stage)), false);
  writeEnv(f.stage, { CODEX_MODEL_CATALOG_ENABLED: "false" }, DIRECT_KEYS); linkAuth(f.stage, f.target);
  f.logs.length = 0;
  assert.equal(await setup(["--check", "--stage", "s01"], f), 0);
  assert.match(f.logs.join("\n"), /已有登录.*链接正确.*Logged in using ChatGPT/);
  assert.equal(await link(["--status", "s01"], f), 0);
  fs.unlinkSync(f.target);
  assert.equal(await link(["--status", "s01"], f), 1);
  assert.match(f.logs.join("\n"), /链接失效/);
});

test("本机 CODEX_HOME 保留；阶段覆盖为隔离目录；不传入 API Key", () => {
  const environment = { CODEX_HOME: "/tmp/example-home", CODEX_API_KEY: secret, KIMI_API_KEY: secret, PATH: "/bin" };
  assert.equal(localAuthPath(environment), "/tmp/example-home/auth.json");
  assert.deepEqual(cleanLoginEnv(environment), { CODEX_HOME: "/tmp/example-home", PATH: "/bin" });
  assert.equal(cleanLoginEnv(environment, "/tmp/stage").CODEX_HOME, "/tmp/stage");
});

test("B 向导隐藏 Key，只改三项，显示目录参数提醒；日志无 Key", async t => {
  const f = fixture(t); f.answers.push("B", "0", "https://example.com/v1", "custom-model", secret, "");
  assert.equal(await setup(["--stage", "s01"], f), 0);
  assert.equal(envFor(f.stage).values.CODEX_API_KEY, secret);
  assert.equal(f.prompts.find(item => item.prompt.startsWith("API Key")).options.secret, true);
  assert.match(f.logs.join("\n"), /CODEX_MODEL_\*/);
  assert.equal(f.logs.join("\n").includes(secret), false);
  assert.equal(f.calls.length, 0);
});

test("A 已登录无需再登录，注释三项、关闭目录开关、链接并复核；保留其余配置", async t => {
  const f = fixture(t); f.answers.push("A", "");
  assert.equal(await setup(["--stage", "s01"], f), 0);
  assert.equal(linkState(f.stage, f.target), "链接正确");
  assert.equal(envFor(f.stage).values.CODEX_API_KEY, undefined);
  assert.equal(envFor(f.stage).values.CODEX_MODEL_CATALOG_ENABLED, "false");
  assert.equal(envFor(f.stage).values.CODEX_MODEL_DISPLAY_NAME, "DeepSeek Flash");
  assert.match(f.logs.join("\n"), /已关闭本地模型目录（ChatGPT 登录使用 Codex 默认模型目录）/);
  assert.equal(/请手工设 CODEX_MODEL_CATALOG_ENABLED/.test(f.logs.join("\n")), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.env.CODEX_HOME, undefined);
  assert.equal(f.calls[1].options.env.CODEX_HOME, stageHome(f.stage));
});

test("A 未登录可拒绝；同意时只登录一次并继承终端", async t => {
  const f = fixture(t); f.answers.push("A", "n");
  f.run = async () => ({ code: 1, output: secret });
  assert.equal(await setup(["--stage", "s01"], f), 1);
  assert.equal(fs.existsSync(path.join(f.stage.dir, ".env")), false);
  assert.equal(f.logs.join("\n").includes(secret), false);
  f.answers.push("A", "y", "n");
  const calls = [];
  f.run = async (cli, args, options) => { calls.push({ args, options }); return { code: calls.length === 1 ? 1 : 0, output: "Logged in using ChatGPT" }; };
  assert.equal(await setup(["--stage", "s01"], f), 0);
  const loginCalls = calls.filter(call => call.args.length === 1 && call.args[0] === "login");
  assert.equal(loginCalls.length, 1);
  assert.equal(loginCalls[0].options.inherit, true);
});

test("A 把目录开关设为 false：已有行只改该行，没有则追加，其余行不变", async t => {
  const f = fixture(t);
  const withLine = "KEEP=1\nCODEX_API_KEY=old\nCODEX_BASE_URL=https://old.example\nCODEX_MODEL=old\nCODEX_MODEL_CATALOG_ENABLED=true\nCODEX_MODEL_DISPLAY_NAME=Name\n# note\n";
  fs.writeFileSync(path.join(f.stage.dir, ".env"), withLine);
  f.answers.push("A", "n");
  assert.equal(await setup(["--stage", "s01"], f), 0);
  assert.equal(fs.readFileSync(path.join(f.stage.dir, ".env"), "utf8"), "KEEP=1\n# CODEX_API_KEY=old\n# CODEX_BASE_URL=https://old.example\n# CODEX_MODEL=old\nCODEX_MODEL_CATALOG_ENABLED=false\nCODEX_MODEL_DISPLAY_NAME=Name\n# note\n");
  const other = f.all.find(item => item.id === "s02");
  const without = "KEEP=2\nCODEX_API_KEY=old\nCODEX_BASE_URL=https://old.example\nCODEX_MODEL=old\nCODEX_MODEL_DISPLAY_NAME=Name\n# note\n";
  fs.writeFileSync(path.join(other.dir, ".env"), without);
  f.answers.push("A", "n");
  assert.equal(await setup(["--stage", "s02"], f), 0);
  assert.equal(fs.readFileSync(path.join(other.dir, ".env"), "utf8"), "KEEP=2\n# CODEX_API_KEY=old\n# CODEX_BASE_URL=https://old.example\n# CODEX_MODEL=old\nCODEX_MODEL_DISPLAY_NAME=Name\n# note\nCODEX_MODEL_CATALOG_ENABLED=false\n");
  assert.equal(envFor(f.stage).values.KEEP, "1");
  assert.equal(envFor(other).values.KEEP, "2");
});

test("B 把目录开关恢复为例示值，其余行不变", async t => {
  const f = fixture(t);
  const exampleText = fs.readFileSync(path.join(f.stage.dir, ".env.example"), "utf8");
  const example = parseEnv(exampleText);
  const seeded = exampleText.replace("CODEX_MODEL_CATALOG_ENABLED=true", "CODEX_MODEL_CATALOG_ENABLED=false");
  assert.notEqual(seeded, exampleText);
  fs.writeFileSync(path.join(f.stage.dir, ".env"), seeded);
  f.answers.push("B", "0", "https://example.com/v1", "custom-model", secret, "n");
  assert.equal(await setup(["--stage", "s01"], f), 0);
  assert.equal(fs.readFileSync(path.join(f.stage.dir, ".env"), "utf8"), editEnv(seeded, {
    CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com/v1", CODEX_MODEL: "custom-model", CODEX_MODEL_CATALOG_ENABLED: example.CODEX_MODEL_CATALOG_ENABLED,
  }));
  assert.equal(envFor(f.stage).values.CODEX_MODEL_CATALOG_ENABLED, example.CODEX_MODEL_CATALOG_ENABLED);
  assert.equal(envFor(f.stage).values.CODEX_MODEL_DISPLAY_NAME, example.CODEX_MODEL_DISPLAY_NAME);
  assert.equal(envFor(f.stage).values.DEMO_TIMEOUT_MS, example.DEMO_TIMEOUT_MS);
  assert.equal(f.logs.join("\n").includes(secret), false);
});

test("B 在示例没有目录开关时不改该行", async t => {
  const f = fixture(t);
  const examplePath = path.join(f.stage.dir, ".env.example");
  fs.writeFileSync(examplePath, fs.readFileSync(examplePath, "utf8").replace(/^CODEX_MODEL_CATALOG_ENABLED=.*\n/m, ""));
  const seeded = "KEEP=1\nCODEX_API_KEY=old\nCODEX_BASE_URL=https://old.example\nCODEX_MODEL=old\nCODEX_MODEL_CATALOG_ENABLED=false\nCODEX_MODEL_DISPLAY_NAME=Keep\n# note\n";
  fs.writeFileSync(path.join(f.stage.dir, ".env"), seeded);
  f.answers.push("B", "0", "https://example.com/v1", "custom-model", secret, "n");
  assert.equal(await setup(["--stage", "s01"], f), 0);
  assert.equal(fs.readFileSync(path.join(f.stage.dir, ".env"), "utf8"), editEnv(seeded, {
    CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com/v1", CODEX_MODEL: "custom-model",
  }));
  assert.equal(envFor(f.stage).values.CODEX_MODEL_CATALOG_ENABLED, "false");
  assert.equal(envFor(f.stage).values.KEEP, "1");
  assert.equal(envFor(f.stage).values.CODEX_MODEL_DISPLAY_NAME, "Keep");
});

test("--check 在已有登录下要求目录开关为 false，且不改文件", async t => {
  const f = fixture(t);
  writeEnv(f.stage, {}, DIRECT_KEYS);
  linkAuth(f.stage, f.target);
  const file = path.join(f.stage.dir, ".env");
  const before = fs.readFileSync(file, "utf8");
  assert.equal(await setup(["--check", "--stage", "s01"], f), 1);
  assert.match(f.logs.join("\n"), /已有登录 \| 设 CODEX_MODEL_CATALOG_ENABLED=false \|/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.writeFileSync(file, before.replace("CODEX_MODEL_CATALOG_ENABLED=true", "CODEX_MODEL_CATALOG_ENABLED=yes"));
  f.logs.length = 0;
  assert.equal(await setup(["--check", "--stage", "s01"], f), 1);
  fs.writeFileSync(file, before.replace(/^CODEX_MODEL_CATALOG_ENABLED=.*\n/m, ""));
  f.logs.length = 0;
  assert.equal(await setup(["--check", "--stage", "s01"], f), 1);
  assert.match(f.logs.join("\n"), /设 CODEX_MODEL_CATALOG_ENABLED=false/);
  writeEnv(f.stage, { CODEX_MODEL_CATALOG_ENABLED: "false" }, DIRECT_KEYS);
  f.logs.length = 0;
  assert.equal(await setup(["--check", "--stage", "s01"], f), 0);
  assert.match(f.logs.join("\n"), /已有登录 \| 无 \|/);
});

test("C 生成网关 Key，跳过的服务商保留，关闭直连入口，日志不含 Key", async t => {
  const f = fixture(t);
  const gateway = f.all.find(item => item.id === "s11");
  writeEnv(gateway, { KIMI_API_KEY: secret, CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com", CODEX_MODEL: "old-direct" });
  // 网关服务商个数由仓库清单读取，最后为网关 Key 与验证回答。
  const catalog = JSON.parse(fs.readFileSync(path.join(f.root, "app/config/models.json")));
  const count = Object.values(catalog.providers).filter(item => item.keyEnv).length;
  f.answers.push("C", ...Array(count).fill(""), "", "");
  assert.equal(await setup(["--stage", "s11"], f), 0);
  const values = envFor(gateway).values;
  assert.match(values.AGENT_GATEWAY_KEY, /^sk-bf-[a-f0-9]{64}$/);
  assert.equal(values.KIMI_API_KEY, secret);
  assert.equal(values.CODEX_API_KEY, undefined);
  assert.equal(values.CODEX_BASE_URL, undefined);
  assert.equal(values.CODEX_MODEL, "kimi/kimi-k2.7-code");
  assert.equal(f.logs.join("\n").includes(secret), false);
  assert.equal(f.logs.join("\n").includes(values.AGENT_GATEWAY_KEY), false);
  assert.notEqual(generateGatewayKey(), generateGatewayKey());
});

test("C 仅用于 s11/app；A/B 不修改网关阶段；s00 只提示", async t => {
  const f = fixture(t);
  for (const [route, stage] of [["C", "s01"], ["B", "s11"], ["A", "app"]]) {
    f.answers.push(route);
    assert.equal(await setup(["--stage", stage], f), 1);
  }
  f.answers.push("A");
  assert.equal(await setup(["--stage", "s00"], f), 0);
  assert.equal(fs.existsSync(path.join(f.root, "stages/s00-sdk-quickstart/.env")), false);
});

test("服务商表仅取仓库示例与模型目录；未提供 URL 则不列入", t => {
  const f = fixture(t);
  assert.deepEqual(providers(f.root).map(item => [item.name, item.baseUrl, item.model]), [
    ["OpenAI", "https://api.openai.com/v1", "gpt-6.1-terra"],
    ["Kimi", "https://api.moonshot.cn", "kimi-k2.7-code"],
    ["DeepSeek", "https://api.deepseek.com", "deepseek-flash"],
  ]);
  fs.writeFileSync(path.join(f.root, "stages/s00-sdk-quickstart/.env.example"), "# no URL\n");
  assert.equal(providers(f.root).some(item => item.id === "openai"), false);
});

test("doctor Base URL 校验：HTTPS、回环例外、末尾 responses 及凭证参数", () => {
  for (const value of ["https://example.com/v1", "http://127.0.0.1:4330", "http://localhost:4330/v1", "http://[::1]:4330"]) assert.equal(validateBaseUrl(value), null);
  for (const value of ["example.com", "http://example.com", "ftp://localhost", "https://example.com/responses", "https://example.com/v1/responses/", "https://user:pass@example.com", "https://example.com?key=fake", "https://example.com/#fragment"]) assert.ok(validateBaseUrl(value));
});

test("doctor 结构化输出与修复建议，不打印原始错误或任意子进程文本", async t => {
  const f = fixture(t); writeEnv(f.stage, { CODEX_API_KEY: secret, CODEX_BASE_URL: "https://example.com/responses", CODEX_MODEL: "test" });
  f.run = async () => ({ code: 1, output: secret });
  assert.equal(await doctor(["--stage", "s01"], f), 1);
  assert.match(f.logs.join("\n"), /移除.*responses/);
  assert.equal(f.logs.join("\n").includes(secret), false);
  f.run = async () => { throw new Error(secret); };
  await doctor(["--stage", "s01"], f);
  assert.equal(f.logs.join("\n").includes(secret), false);
  assert.equal((await loginStatus("mock", {}, async () => ({ code: 0, output: "Logged in using an API key " + secret }))).ok, false);
});

test("doctor 可注入握手；A 模式提示模型目录冲突；不调用模型", async t => {
  const f = fixture(t); writeEnv(f.stage, {}, DIRECT_KEYS); linkAuth(f.stage, f.target);
  let handshakes = 0;
  f.run = async (cli, args) => ({ code: 0, output: args[0] === "--version" ? "codex-cli 0.154.0" : "Logged in using ChatGPT" });
  f.handshakeRun = async (cli, options) => { handshakes++; assert.equal(options.env.CODEX_HOME, stageHome(f.stage)); return true; };
  assert.equal(await doctor(["--stage", "s01", "--handshake"], f), 1);
  assert.match(f.logs.join("\n"), /CODEX_MODEL_CATALOG_ENABLED=false/);
  assert.match(f.logs.join("\n"), /✓ App Server initialize\/initialized/);
  assert.equal(handshakes, 1);
});

test("握手只发送 initialize/initialized，随后关闭子进程", async () => {
  const sent = [];
  let killed = false;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const message = JSON.parse(chunk.toString()); sent.push(message);
    if (message.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "mock" } }) + "\n"));
    callback();
  } });
  child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", 0)); };
  assert.equal(await handshake("mock", { spawnImpl: (command, args) => { assert.deepEqual(args, ["app-server", "--listen", "stdio://"]); return child; } }), true);
  assert.deepEqual(sent.map(message => message.method), ["initialize", "initialized"]);
  assert.equal(killed, true);
});

test("握手超时和错误响应失败并终止进程", async () => {
  for (const reply of [null, { id: 1, error: { message: secret } }]) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) { if (reply) queueMicrotask(() => child.stdout.write(JSON.stringify(reply) + "\n")); callback(); } });
    let killed = false;
    child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", 1)); };
    assert.equal(await handshake("mock", { spawnImpl: () => child, timeoutMs: 10 }), false);
    assert.equal(killed, true);
  }
});

test("最小验证默认否；同意后只执行一个阶段、60 秒、隐藏模型输出", async t => {
  const f = fixture(t);
  f.answers.push(""); await minimalValidation([f.stage], f); assert.equal(f.calls.length, 0);
  f.answers.push("yes"); await minimalValidation([f.stage], f);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ["main.mjs", "只回复：好"]);
  assert.equal(f.calls[0].options.timeoutMs, 60000);
});

test("通用子进程超时结束，不向父进程输出 stdout/stderr", async () => {
  const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 });
  assert.equal(result.timedOut, true);
});

test("阶段选择和启动命令符合实际 package.json", t => {
  const f = fixture(t);
  assert.equal(selectStages(f.all, ["s05,s06", "s05"]).length, 2);
  assert.throws(() => selectStages(f.all, ["../elsewhere"]));
  for (const stage of f.all) {
    const commands = startCommands(stage);
    const scripts = JSON.parse(fs.readFileSync(path.join(stage.dir, "package.json"))).scripts;
    for (const command of commands) {
      const match = command.match(/npm --prefix \S+ run (\S+)/);
      if (match) assert.ok(scripts[match[1]], `${stage.id} 缺少脚本`);
    }
  }
});

test("A 默认仅 s01–s10；链接共用同一本机文件，未改 s00/s11/app", async t => {
  const f = fixture(t); f.answers.push("A", "", "");
  assert.equal(await setup([], f), 0);
  for (const stage of f.all) {
    if (/^s(0[1-9]|10)$/.test(stage.id)) {
      assert.equal(linkState(stage, f.target), "链接正确");
      assert.equal(envFor(stage).exists, true);
      assert.equal(envFor(stage).values.CODEX_MODEL_CATALOG_ENABLED, "false");
    } else assert.equal(envFor(stage).exists, false);
  }
  assert.equal(f.calls.length, 11);
});

test("C 默认只写 s11/s12/s13/s14/s15/s16/s17/s18/app，各生成网关 Key，保留业务配置", async t => {
  const f = fixture(t);
  const count = Object.values(JSON.parse(fs.readFileSync(path.join(f.root, "app/config/models.json"))).providers).filter(item => item.keyEnv).length;
  f.answers.push("C", "", secret, ...Array(count - 1).fill(""), "", "");
  assert.equal(await setup([], f), 0);
  for (const stage of f.all) {
    if (["s11", "s12", "s13", "s14", "s15", "s16", "s17", "s18", "app"].includes(stage.id)) {
      const values = envFor(stage).values;
      assert.match(values.AGENT_GATEWAY_KEY, /^sk-bf-[a-f0-9]{64}$/);
      if (["s12", "s13", "s14", "s15", "s16", "s17", "s18", "app"].includes(stage.id)) {
        assert.ok(Object.hasOwn(values, "AGENT_DB_PASSWORD"));
        assert.ok(Object.hasOwn(values, "CONTAINER_APP_DIR"));
        assert.equal(values.DATABASE_URL, undefined); // 由独立 Compose 注入。
      } else assert.ok(values.DATABASE_URL);
    } else assert.equal(envFor(stage).exists, false);
  }
  assert.equal(f.logs.join("\n").includes(secret), false);
});

test("状态目录为符号链接时不写入、也不跨目录 unlink", t => {
  const f = fixture(t);
  const external = path.join(f.root, "external");
  fs.mkdirSync(path.join(external, "codex"), { recursive: true });
  fs.symlinkSync(f.target, path.join(external, "codex/auth.json"));
  fs.symlinkSync(external, path.join(f.stage.dir, ".data"));
  assert.throws(() => linkAuth(f.stage, f.target), /真实目录/);
  assert.match(unlinkAuth(f.stage), /跳过/);
  assert.equal(fs.lstatSync(path.join(external, "codex/auth.json")).isSymbolicLink(), true);
});

test("s12 启动说明指向独立部署与 SSH 隧道", () => {
  const stage = stages(ROOT).find(stage => ["s12", "s13", "s14", "s15", "s16", "s17", "s18", "app"].includes(stage.id));
  const commands = startCommands(stage).join("\n");
  assert.match(commands, /s12-deploy\/README\.md/);
  assert.match(commands, /remote\.sh tunnel/);
  assert.doesNotMatch(commands, /npm .*run server/);
});

test('s13 是网关独立部署，排除 link-login，启动说明要求登录',()=>{
 const all=stages(ROOT),stage=all.find(stage=>stage.id==='s13');
 assert.equal(classify({AGENT_GATEWAY_KEY:secret},true,stage).kind,'gateway');
 assert.ok(!loginStages(all).includes(stage));
 const commands=startCommands(stage).join('\n');
 assert.match(commands,/s13-auth\/README\.md/);
 assert.match(commands,/remote\.sh tunnel/);
 assert.match(commands,/npm run login/);
 assert.doesNotMatch(commands,/npm .*run server/);
});
test('s14 是网关独立部署，排除 link-login，启动说明要求登录',()=>{
 const all=stages(ROOT),stage=all.find(stage=>stage.id==='s14');
 assert.equal(classify({AGENT_GATEWAY_KEY:secret},true,stage).kind,'gateway');
 assert.ok(!loginStages(all).includes(stage));
 const commands=startCommands(stage).join('\n');
 assert.match(commands,/s14-isolation\/README\.md/);
 assert.match(commands,/remote\.sh tunnel/);
 assert.match(commands,/npm run login/);
 assert.doesNotMatch(commands,/npm .*run server/);
});

test('s15 是网关独立部署，排除 link-login，启动说明要求登录',()=>{
 const all=stages(ROOT),stage=all.find(stage=>stage.id==='s15');
 assert.equal(classify({AGENT_GATEWAY_KEY:secret},true,stage).kind,'gateway');
 assert.ok(!loginStages(all).includes(stage));
 const commands=startCommands(stage).join('\n');
 assert.match(commands,/s15-hub\/README\.md/);
 assert.match(commands,/remote\.sh tunnel/);
 assert.match(commands,/npm run login/);
 assert.doesNotMatch(commands,/npm .*run server/);
});
test('s16 是网关独立部署，排除 link-login，启动说明要求登录',()=>{
 const all=stages(ROOT),stage=all.find(stage=>stage.id==='s16');
 assert.equal(classify({AGENT_GATEWAY_KEY:secret},true,stage).kind,'gateway');
 assert.ok(!loginStages(all).includes(stage));
 const commands=startCommands(stage).join('\n');
 assert.match(commands,/s16-coordination\/README\.md/);
 assert.match(commands,/remote\.sh tunnel/);
 assert.match(commands,/npm run login/);
 assert.doesNotMatch(commands,/npm .*run server/);
});

test('s17 是网关独立部署，排除 link-login，启动说明要求登录',()=>{
 const all=stages(ROOT),stage=all.find(stage=>stage.id==='s17');
 assert.equal(classify({AGENT_GATEWAY_KEY:secret},true,stage).kind,'gateway');
 assert.ok(!loginStages(all).includes(stage));
 const commands=startCommands(stage).join('\n');
 assert.match(commands,/s17-sharding\/README\.md/);
 assert.match(commands,/remote\.sh tunnel/);
 assert.match(commands,/npm run login/);
 assert.doesNotMatch(commands,/npm .*run server/);
});

test('s18 是网关独立部署，排除 link-login，启动说明要求登录',()=>{
 const all=stages(ROOT),stage=all.find(stage=>stage.id==='s18');
 assert.equal(classify({AGENT_GATEWAY_KEY:secret},true,stage).kind,'gateway');
 assert.ok(!loginStages(all).includes(stage));
 const commands=startCommands(stage).join('\n');
 assert.match(commands,/s18-replication\/README\.md/);
 assert.match(commands,/remote\.sh tunnel/);
 assert.match(commands,/npm run login/);
 assert.doesNotMatch(commands,/npm .*run server/);
});

test('app 使用最终章部署内核，启动指引默认单节点且要求账号登录', () => {
  const commands = startCommands(stages(ROOT).find(stage => stage.id === 'app')).join('\n');
  for (const text of ['app/README.md', '默认单节点', 'bash deploy/configure.sh', 'docker compose up -d --wait', 'npm run login']) assert.ok(commands.includes(text), text);
  assert.doesNotMatch(commands, /run server|run data:migrate/);
});
