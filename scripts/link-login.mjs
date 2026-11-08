import fs from "node:fs";
import {
  ROOT, stages, loginStages, selectStages, parseArgs, localAuthPath, stageHome,
  linkAuth, linkState, unlinkAuth, findCodex, codexPath, cleanLoginEnv, safeError, fail, isMain,
} from "./model-common.mjs";
import { runProcess, loginStatus } from "./model-io.mjs";

export async function linkAndVerify(selected, { target, cli, env, run = runProcess, log = console.log, statusOnly = false } = {}) {
  let ok = true;
  for (const stage of selected) {
    try {
      if (!statusOnly) log(`${stage.id}: ${linkAuth(stage, target)}`);
      const state = linkState(stage, target);
      const ownCli = codexPath(stage);
      const status = await loginStatus(fs.existsSync(ownCli) ? ownCli : cli, cleanLoginEnv(env, stageHome(stage)), run);
      log(`${stage.id} | ${state} | ${status.text}`);
      if (state !== "链接正确" || !status.ok) ok = false;
    } catch (error) { ok = false; log(`${stage.id}: ${safeError(error)}`); }
  }
  return ok;
}

export async function main(argv = process.argv.slice(2), { root = ROOT, env = process.env, run = runProcess, log = console.log, home } = {}) {
  try {
    const options = parseArgs(argv, ["--status", "--unlink", "--help"]);
    if (options.help) { log("npm run link-login -- [--stage s05,s06] [--status | --unlink]（默认 s01–s10；不修改 .env）"); return 0; }
    if (options.status && options.unlink) fail("--status 与 --unlink 不能同时使用。");
    const all = stages(root);
    const selected = selectStages(all, options.selectors, loginStages(all));
    if (selected.some(stage => !loginStages(all).includes(stage))) fail("link-login 只支持 s01–s10；s00 使用本机登录，s11/s12/s13/s14/s15/s16/s17/app 使用模型网关。");
    if (options.unlink) {
      for (const stage of selected) log(`${stage.id}: ${unlinkAuth(stage)}`);
      return 0;
    }
    const target = localAuthPath(env, home);
    if (!options.status && !fs.existsSync(target)) fail("未找到本机 auth.json；先运行 npx codex login，再运行 npm run link-login。");
    let cli;
    try { cli = findCodex(all); } catch { /* --status 仍输出链接状态 */ }
    return await linkAndVerify(selected, { target, cli, env, run, log, statusOnly: options.status }) ? 0 : 1;
  } catch (error) { log(safeError(error)); return 1; }
}
if (isMain(import.meta.url)) process.exitCode = await main();
