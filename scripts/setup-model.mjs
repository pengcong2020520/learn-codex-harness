import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  ROOT, DIRECT_KEYS, stages, loginStages, gatewayStage, selectStages, parseArgs, envFor, writeEnv,
  readText, providers, gatewayKeys, generateGatewayKey, localAuthPath, findCodex, cleanLoginEnv, linkState,
  validateBaseUrl, safeError, fail, isMain,
} from "./model-common.mjs";
import { askTerminal, runProcess, loginStatus } from "./model-io.mjs";
import { linkAndVerify } from "./link-login.mjs";
import { checkTable } from "./doctor.mjs";

const yes = value => /^(y|yes|是)$/i.test(value.trim());
async function required(ask, prompt, options) {
  const value = (await ask(prompt, options)).trim();
  if (!value) fail("必填项为空，未写入配置。请重新运行向导。");
  return value;
}
export function startCommands(stage) {
  if (stage.id === "app") return [
    "进入 app/ 运行 npm run setup（默认单节点，包含账号初始化）。",
    "cd app", "npm run setup", "npm run login", "npm run chat",
  ];
  if (stage.id === "s00") return [`npm --prefix ${stage.relative} run hello`];
  if (["s12", "s13", "s14", "s15", "s16", "s17", "s18"].includes(stage.id)) return [
    `按 ${stage.relative}/README.md 填写独立部署配置并构建、初始化 Compose。`,
    `cd ${stage.relative}`, "bash deploy/remote.sh tunnel（远程部署完成后）",
    ...(["s13", "s14", "s15", "s16", "s17", "s18"].includes(stage.id) ? [`另开终端进入阶段目录，npm run login 后 npm run chat（端口 ${{ s13: 4327, s14: 4328, s15: 4329, s16: 4334, s17: 4335, s18: 4336 }[stage.id]}）`] : []),
  ];
  const prefix = `npm --prefix ${stage.relative}`;
  const scripts = JSON.parse(readText(path.join(stage.dir, "package.json")) || "{}").scripts || {};
  if (["s01", "s02"].includes(stage.id)) return [`${prefix} start`];
  return [
    ...(/^s(08|09|10|11)$/.test(stage.id) ? [scripts["db:up"] ? `${prefix} run db:up` : `docker compose --project-directory ${stage.relative} up -d postgres redis`, `${prefix} run data:migrate`] : []),
    ...(gatewayStage(stage) ? [`${prefix} run gateway:up`] : []),
    `${prefix} run server`, `${prefix} start（另一个终端）`,
  ];
}

export async function minimalValidation(selected, { ask, run, env, log }) {
  if (!yes(await ask("是否用一轮最小对话验证（会调用模型、产生少量费用）？[y/N] "))) return;
  // s01/s02 的现有入口能明确限制为一轮；服务阶段 smoke 会执行多轮，不能冒充最小对话。
  const candidates = selected.filter(stage => ["s01", "s02"].includes(stage.id));
  if (!candidates.length) { log("所选阶段没有可保证单轮的现有入口，已跳过；可单独配置 s01 后验证，或按阶段说明手工验证。"); return; }
  const chosen = candidates.length === 1 ? candidates[0] : selectStages(candidates, [(await ask(`只验证一个阶段 [${candidates[0].id}]：`)).trim() || candidates[0].id])[0];
  if (!chosen) return;
  log(`${chosen.id}: 开始一轮最小对话；60 秒超时。`);
  // 直接运行 npm start 对应的 main.mjs，避免 npm shell 和输出回显密钥。
  const result = await run(process.execPath, ["main.mjs", "只回复：好"], { cwd: chosen.dir, env, timeoutMs: 60_000 });
  log(result.code === 0 && !result.timedOut ? "最小对话完成（模型原始输出已隐藏）。" : "最小对话失败或超时；检查登录、Key、地址及模型能力（原始输出已隐藏）。");
}

export async function main(argv = process.argv.slice(2), { root = ROOT, env = process.env, home, ask = askTerminal, run = runProcess, log = console.log } = {}) {
  try {
    const options = parseArgs(argv, ["--check", "--help"]);
    const all = stages(root);
    if (options.help) { log("npm run setup:model -- [--stage s05,s06] [--check]；交互默认 s01–s10，C 默认 s11、s12、s13、s14、s15、s16、s17、s18；app 请进入 app/ 运行 npm run setup；--check 默认全部，只读。"); return 0; }
    if (options.check) return await checkTable(selectStages(all, options.selectors), { root, env, home, run, log }) ? 0 : 1;
    const requested = options.selectors.length ? selectStages(all, options.selectors) : all;
    if (requested.some(stage => stage.id === "app")) log("进入 app/ 运行 npm run setup");
    if (requested.every(stage => stage.id === "app")) return 0;
    log("s00-sdk-quickstart 保持现状：SDK 直接使用本机登录或 CODEX_API_KEY，本向导不写入 s00。");
    log("A ChatGPT 账号登录：使用订阅额度，无需 API Key，仅 OpenAI 模型。\nB 一个 API Key：直连兼容 Responses 的服务商。\nC 多个 API Key：模型网关，仅 s11、s12、s13、s14、s15、s16、s17、s18。");
    const route = (await ask("选择路线 [A/B/C]：")).trim().toUpperCase();
    if (!["A", "B", "C"].includes(route)) fail("请选择 A、B 或 C。");
    const defaults = route === "C" ? all.filter(stage => stage.id !== "app" && gatewayStage(stage)) : loginStages(all);
    const selectors = options.selectors.length ? options.selectors : [(await ask(`阶段（逗号分隔，回车默认 ${route === "C" ? "s11,s12,s13,s14,s15,s16,s17,s18" : "s01–s10"}）：`)).trim()].filter(Boolean);
    const selected = selectStages(all, selectors, defaults).filter(stage => !["s00", "app"].includes(stage.id));
    if (!selected.length) return 0;
    if (route === "C" && selected.some(stage => !gatewayStage(stage))) fail("路线 C 只支持 s11、s12、s13、s14、s15、s16、s17、s18。");
    if (route !== "C" && selected.some(gatewayStage)) fail("s11、s12、s13、s14、s15、s16、s17、s18 请使用路线 C；路线 A/B 用于 s01–s10。");
    // 同名进程变量优先于文件，先提示，避免写完文件却实际仍用另一套认证。
    if (DIRECT_KEYS.some(key => Object.hasOwn(env, key)) || env.AGENT_GATEWAY_KEY) {
      log("提示：当前终端设置了模型环境变量，会覆盖 .env；启动前请清除同名变量。变量值不显示。");
    }
    let ok = true;
    if (route === "B") {
      const choices = providers(root);
      log(choices.map((item, i) => `${i + 1} ${item.name} | ${item.baseUrl} | ${item.model}`).concat("0 自定义").join("\n"));
      const choice = await required(ask, "选择服务商编号：");
      if (!/^\d+$/.test(choice) || Number(choice) > choices.length) fail("服务商编号无效。");
      const provider = choices[Number(choice) - 1];
      const baseUrl = provider?.baseUrl || await required(ask, "Base URL（完整基础地址，隐藏输入）：", { secret: true });
      const problem = validateBaseUrl(baseUrl);
      if (problem) fail(problem);
      const model = provider ? (await ask(`模型名（回车使用仓库推荐值）：`)).trim() || provider.model : await required(ask, "模型名：");
      const key = await required(ask, "API Key（隐藏输入）：", { secret: true });
      for (const stage of selected) {
        const example = parseEnv(readText(path.join(stage.dir, ".env.example")) || "");
        const updates = { CODEX_API_KEY: key, CODEX_BASE_URL: baseUrl, CODEX_MODEL: model };
        // 示例没有这一项时不写入，避免把用户已有的开关改掉。
        if (Object.hasOwn(example, "CODEX_MODEL_CATALOG_ENABLED")) updates.CODEX_MODEL_CATALOG_ENABLED = example.CODEX_MODEL_CATALOG_ENABLED;
        writeEnv(stage, updates);
        log(`${stage.id}: 已写入 API Key 配置（Key：***），.env 权限 0600。`);
        if (model !== example.CODEX_MODEL) {
          const restored = Object.hasOwn(example, "CODEX_MODEL_CATALOG_ENABLED") ? "目录开关已按示例恢复，" : "";
          log(`${stage.id}: 所选模型与示例不同，请核对 CODEX_MODEL_* 能力参数；${restored}其余能力参数未自动修改。`);
        }
      }
    } else if (route === "A") {
      const cli = findCodex(all);
      let status = await loginStatus(cli, cleanLoginEnv(env), run);
      log(`本机：${status.text}`);
      if (!status.ok) {
        if (!yes(await ask("是否现在执行一次 codex login（继承终端，可能打开浏览器）？[y/N] "))) {
          log("请先执行 npx codex login，再重新运行本向导；尚未修改配置。"); return 1;
        }
        const result = await run(cli, ["login"], { env: cleanLoginEnv(env), inherit: true, timeoutMs: 300_000 });
        if (result.cleanupFailed) fail("登录子进程树未确认退出；请检查并结束残留 Codex 进程后重试。");
        if (result.code !== 0 || result.timedOut || result.failed) fail("登录未完成；请执行 npx codex login 后重试。");
        status = await loginStatus(cli, cleanLoginEnv(env), run);
        if (!status.ok) fail("尚未确认 ChatGPT 登录；请执行 npx codex login 后重试。");
      }
      const target = localAuthPath(env, home);
      if (!fs.existsSync(target)) fail("本机 auth.json 不存在，请检查 CODEX_HOME 后重新登录。");
      ok = await linkAndVerify(selected, { target, cli, env, run, log });
      // 每阶段确认链接成功后才移除 API 配置，避免 Windows 链接失败造成配置损失。
      for (const stage of selected) {
        if (linkState(stage, target) !== "链接正确") continue;
        writeEnv(stage, { CODEX_MODEL_CATALOG_ENABLED: "false" }, DIRECT_KEYS);
        log(`${stage.id}: 已注释 CODEX_API_KEY / CODEX_BASE_URL / CODEX_MODEL。`);
        log(`${stage.id}: 已关闭本地模型目录（ChatGPT 登录使用 Codex 默认模型目录）。`);
      }
    } else {
      const updates = {};
      for (const key of gatewayKeys(root)) {
        const value = (await ask(`${key}（隐藏输入，回车保留现值或跳过）：`, { secret: true })).trim();
        if (value) updates[key] = value;
      }
      const gatewayKey = (await ask("AGENT_GATEWAY_KEY（隐藏输入，回车保留现值；为空则自动生成）：", { secret: true })).trim();
      for (const stage of selected) {
        const existing = envFor(stage).values;
        const example = parseEnv(readText(path.join(stage.dir, ".env.example")) || "");
        const merged = { ...updates, AGENT_GATEWAY_KEY: gatewayKey || existing.AGENT_GATEWAY_KEY?.trim() || generateGatewayKey() };
        // 清除直连入口；模型选择交回仓库的网关默认值，避免沿用直连裸模型名。
        merged.CODEX_MODEL = existing.AGENT_GATEWAY_KEY && existing.CODEX_MODEL ? existing.CODEX_MODEL : example.CODEX_MODEL || "";
        writeEnv(stage, merged, ["CODEX_API_KEY", "CODEX_BASE_URL"]);
        log(`${stage.id}: 已配置模型网关（Key：***），.env 权限 0600。`);
        if (!gatewayKeys(root).some(key => ({ ...existing, ...updates })[key]?.trim())) log(`${stage.id}: 尚未填写服务商 Key；网关暂时没有可用的云模型。`);
      }
    }
    log("下一步：npm run doctor");
    for (const stage of selected) for (const command of startCommands(stage)) log(command);
    if (ok) await minimalValidation(selected, { ask, run, env, log });
    return ok ? 0 : 1;
  } catch (error) { log(safeError(error)); return 1; }
}
if (isMain(import.meta.url)) process.exitCode = await main();
