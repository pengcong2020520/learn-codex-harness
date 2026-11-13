import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { createPrompts } from '../shared/prompts.mjs';
import { validateClusterSecrets, clusterNodes } from '../server/modules/config/cluster.mjs';
import { generateDeployEnv } from './deploy-env.mjs';
import { PROJECT_ROOT, isMain, readEnv, writeEnv, childEnvironment, commandRedactor, runProcess, composeUp, accountArgs, entryUrl, checkPort, waitReady, validateUsername, validatePassword } from './quickstart-lib.mjs';

export function parseSetup(argv) {
  const allowed = ['--non-interactive', '--no-start', '--reconfigure-model', '--quiet'];
  if (argv.some(arg => !allowed.includes(arg)) || new Set(argv).size !== argv.length) throw new Error('用法：npm run setup -- [--non-interactive] [--no-start] [--reconfigure-model] [--quiet]。');
  return { interactive: !argv.includes('--non-interactive'), start: !argv.includes('--no-start'), reconfigure: argv.includes('--reconfigure-model'), quiet: argv.includes('--quiet') };
}
export async function setup(argv = process.argv.slice(2), { root = PROJECT_ROOT, env = process.env, prompts, run = runProcess, portCheck = checkPort, ready = waitReady, log = console.log, output = text => process.stdout.write(text) } = {}) {
  const options = parseSetup(argv), exists = fs.existsSync(path.join(root, '.env'));
  if (exists && !options.reconfigure) { log('已配置；要重新生成请先备份并删除 .env'); return; }
  if (!exists && options.reconfigure) throw new Error('尚未配置，请先运行 npm run setup。');
  const previous = exists ? readEnv(root) : {};
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/models.json'), 'utf8'));
  const models = Object.keys(catalog.models).filter(id => catalog.models[id].purposes.includes('chat'));
  if (options.interactive) prompts ??= createPrompts();
  let values, username, password;
  try {
    let model = env.CODEX_MODEL || previous.CODEX_MODEL || 'deepseek/deepseek-flash';
    if (options.interactive) {
      log(models.map((id, i) => `${i + 1}. ${id}`).join('\n'));
      const answer = (await prompts.ask(`选择模型编号或名称 [${model}]：`)).trim();
      if (answer) model = /^\d+$/.test(answer) ? models[+answer - 1] : answer;
    }
    if (!models.includes(model)) throw new Error('CODEX_MODEL 必须是 config/models.json 中用途含 chat 的模型。');
    const keyEnv = catalog.providers[model.split('/')[0]].keyEnv;
    const key = options.interactive ? await prompts.ask(`${keyEnv}（隐藏输入，可留空稍后填）：`, { secret: true }) : env[keyEnv] || '';
    if (!key && !previous[keyEnv]) log(`尚未填写 ${keyEnv}；服务可能无法就绪，稍后请运行 npm run setup -- --reconfigure-model。`);
    const updates = { CODEX_MODEL: model, CODEX_MODEL_CATALOG_ENABLED: 'true', [keyEnv]: key || previous[keyEnv] || '' };
    if (options.reconfigure) values = { ...previous, ...updates };
    else {
      const domain = (options.interactive ? await prompts.ask('对外域名（可留空）：') : env.SETUP_DOMAIN || '').trim();
      if (domain && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) throw new Error('SETUP_DOMAIN 只接受域名，不含协议、路径或端口。');
      username = options.interactive ? (await prompts.ask('管理员用户名 [admin]：')).trim() || 'admin' : env.SETUP_ADMIN_USER || 'admin';
      password = options.interactive ? await prompts.ask('管理员密码（至少 12 位）：', { secret: true }) : env.SETUP_ADMIN_PASSWORD;
      validateUsername(username); validatePassword(password);
      if (options.interactive && password !== await prompts.ask('再次输入管理员密码：', { secret: true })) throw new Error('两次密码不一致。');
      const template = parseEnv(fs.readFileSync(path.join(root, '.env.example'), 'utf8'));
      values = generateDeployEnv(updates, template, path.resolve(root));
      values.AGENT_ALLOWED_ORIGINS = `http://127.0.0.1:4317,http://localhost:4317${domain ? `,https://${domain}` : ''}`;
    }
  } finally { prompts?.close(); }
  validateClusterSecrets(values, clusterNodes(values));
  const redact = await commandRedactor(env, previous, values, { SETUP_ADMIN_PASSWORD: password });
  const childEnv = childEnvironment(env), execute = (command, args, extra = {}) => run(command, args, { root, env: childEnv, output, redact, quiet: options.quiet, ...extra });
  if (options.start) {
    log('检查 Docker Compose 与入口端口……');
    try { await execute('docker', ['compose', 'version']); }
    catch { throw new Error('Docker Compose 不可用，请安装并启动 Docker，确认 docker compose version 可运行。'); }
    if (!options.reconfigure) await portCheck(4317);
  }
  writeEnv(root, values);
  log('已写入 .env（权限 0600）。');
  if (!options.start) return values;
  log('构建镜像并准备数据目录……');
  await execute('bash', ['deploy/configure.sh']);
  log('启动服务……');
  await execute('docker', composeUp(values));
  if (!options.reconfigure) await execute('docker', accountArgs(root, 'init', [], values), { input: `${username}\n${password}\n` });
  await ready(values, { log });
  log(`入口：${entryUrl(values)}/\n下一步：npm run login && npm run chat；npm run agent:new -- my-agent。`);
  return values;
}
if (isMain(import.meta.url)) setup().catch(error => { console.error(error.code ? '配置失败，请检查文件权限；内容未显示。' : error.message); process.exitCode = 1; });
