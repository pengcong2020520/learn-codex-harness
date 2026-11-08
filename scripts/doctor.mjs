import fs from "node:fs";
import path from "node:path";
import {
  ROOT, stages, selectStages, parseArgs, envFor, classify, validateBaseUrl, localAuthPath,
  linkState, stageHome, codexPath, cleanLoginEnv, gatewayKeys, safeError, isMain,
} from "./model-common.mjs";
import { runProcess, loginStatus, handshake } from "./model-io.mjs";

export async function inspectStage(stage, { root = ROOT, env = {}, home, run = runProcess } = {}) {
  const configuration = envFor(stage, env);
  const mode = classify(configuration.values, configuration.exists, stage);
  let login = { ok: true, text: "不适用" };
  let link = "不适用";
  if (mode.kind === "login") {
    const target = localAuthPath(env, home);
    link = stage.id === "s00" ? "SDK 使用本机登录" : linkState(stage, target);
    const cli = codexPath(stage);
    login = await loginStatus(fs.existsSync(cli) ? cli : null, cleanLoginEnv(env, stage.id === "s00" ? undefined : stageHome(stage)), run);
  }
  if (mode.kind === "gateway") {
    if (!gatewayKeys(root).some(key => configuration.values[key]?.trim())) mode.missing.push("至少一个服务商 API Key");
  }
  const baseUrlProblem = mode.kind === "api" && !(stage.id === "s00" && !configuration.values.CODEX_BASE_URL)
    ? validateBaseUrl(configuration.values.CODEX_BASE_URL) : null;
  return { ...configuration, ...mode, login, link, baseUrlProblem };
}

export async function checkTable(selected, context = {}) {
  const log = context.log || console.log;
  log("阶段 | 模式 | 缺项 | 登录状态");
  let ok = true;
  for (const stage of selected) {
    try {
      const item = await inspectStage(stage, context);
      log(`${stage.id} | ${item.mode} | ${item.missing.join("、") || "无"} | ${item.kind === "login" ? `${item.link}；${item.login.text}` : "不适用"}`);
      if (item.baseUrlProblem) log(`${stage.id} | Base URL：${item.baseUrlProblem}`);
      if (item.baseUrlProblem || item.missing.length || !item.login.ok || (item.kind === "login" && stage.id !== "s00" && item.link !== "链接正确")) ok = false;
    } catch (error) { log(`${stage.id} | 检查失败 | ${safeError(error)} | 未检查`); ok = false; }
  }
  return ok;
}

export async function main(argv = process.argv.slice(2), { root = ROOT, env = process.env, home, run = runProcess, handshakeRun = handshake, log = console.log } = {}) {
  try {
    const options = parseArgs(argv, ["--handshake", "--help"]);
    if (options.help) { log("npm run doctor -- [--stage s05,s06] [--handshake]（默认 s00–s16 与 app；不调用模型）"); return 0; }
    const selected = selectStages(stages(root), options.selectors);
    let ok = true;
    for (const stage of selected) {
      log(`\n${stage.id}`);
      const report = (passed, label, advice = "") => {
        log(`${passed ? "✓" : "✗"} ${label}${passed || !advice ? "" : `；${advice}`}`);
        if (!passed) ok = false;
      };
      try {
        const cli = codexPath(stage);
        const installed = fs.existsSync(path.join(stage.dir, "node_modules")) && fs.existsSync(cli);
        report(installed, "依赖与 Codex", `运行 npm --prefix ${stage.relative} ci${stage.id === "app" ? "；根工具还需 npm --prefix stages/s11-model-gateway ci" : ""}`);
        const item = await inspectStage(stage, { root, env, home, run });
        report(item.exists, ".env 存在", stage.id === "s00" ? "按 s00 README 配置（SDK 也可直接用本机登录）" : "运行 npm run setup:model");
        report(!item.missing.length, `模式：${item.mode}`, `补齐 ${item.missing.join("、")}`);
        if (item.kind === "api") {
          report(!item.baseUrlProblem, "Base URL", item.baseUrlProblem);
        } else if (item.kind === "gateway") report(true, "Base URL：由模型网关配置提供");
        else {
          if (stage.id !== "s00") report(item.link === "链接正确", item.link, "运行 npm run link-login");
          report(item.login.ok, item.login.text, "重新 npx codex login；链接会自动使用更新后的凭证");
        }
        if (item.kind !== "login" && stage.id !== "s00" && item.values.CODEX_MODEL_CATALOG_ENABLED === "true" && !item.values.CODEX_MODEL?.trim()) {
          report(false, "本地模型目录缺少模型名", "填写 CODEX_MODEL，或设 CODEX_MODEL_CATALOG_ENABLED=false");
        }
        if (["s12", "s13", "s14", "s15", "s16"].includes(stage.id)) {
          report(Boolean(item.values.AGENT_DB_PASSWORD?.trim() && item.values.CONTAINER_APP_DIR?.trim()), "独立部署配置（不检查 Docker）", `填写 AGENT_DB_PASSWORD / CONTAINER_APP_DIR，按 ${stage.id} README 配置 Compose`);
          log(`提示：数据库与 Redis URL 由 Compose 注入；部署与 SSH 隧道见 ${stage.relative}/README.md。`);
        } else if (/^s(08|09|10|11)$/.test(stage.id) || stage.id === "app") {
          report(Boolean(item.values.DATABASE_URL && item.values.REDIS_URL), "数据库配置（不检查连通性）", "配置 DATABASE_URL / REDIS_URL，按阶段说明启动数据库并迁移");
          log("提示：启动前还需 PostgreSQL、Redis 与 data:migrate；本检查不连接数据库。");
        }
        if (installed) {
          const version = await run(cli, ["--version"], { cwd: stage.dir, env: cleanLoginEnv(env) });
          const number = version.output?.match(/\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+)\b/i)?.[1];
          report(version.code === 0 && Boolean(number), `Codex 版本${number ? `：${number}` : "不可读取"}`, "在阶段目录重新 npm ci");
        } else report(false, "Codex 版本不可读取", "先安装依赖");
        if (options.handshake) {
          // 握手只验证该阶段 CLI 的 initialize/initialized；不发送 model/list、thread/start、turn/start。
          const passed = installed && await handshakeRun(cli, { cwd: stage.dir, env: cleanLoginEnv(env, stage.id === "s00" ? undefined : stageHome(stage)) });
          report(passed, "App Server initialize/initialized", "确认依赖、状态目录权限和 Codex 可运行；握手不验证 Key 或模型能力");
        }
      } catch (error) { report(false, safeError(error)); }
    }
    return ok ? 0 : 1;
  } catch (error) { log(safeError(error)); return 1; }
}
if (isMain(import.meta.url)) process.exitCode = await main();
