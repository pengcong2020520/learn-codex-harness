import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { createPrompts } from '../shared/prompts.mjs';
import { validateClusterSecrets, clusterNodes } from '../server/modules/config/cluster.mjs';
import { generateDeployEnv } from './deploy-env.mjs';
import { PROJECT_ROOT, isMain, readEnv, writeEnv, childEnvironment, commandRedactor, runProcess, composeUp, accountArgs, entryUrl, checkPort, waitReady, validateUsername, validatePassword, checkRuntimeEnvironment, checkDocker } from './quickstart-lib.mjs';

export function parseSetup(argv) {
  const allowed = ['--non-interactive', '--no-start', '--reconfigure-model', '--quiet'];
  if (argv.some(arg => !allowed.includes(arg)) || new Set(argv).size !== argv.length) throw new Error('用法：npm run setup -- [--non-interactive] [--no-start] [--reconfigure-model] [--quiet]。');
  return { interactive: !argv.includes('--non-interactive'), start: !argv.includes('--no-start'), reconfigure: argv.includes('--reconfigure-model'), quiet: argv.includes('--quiet') };
}
function validateDomain(domain, variable = 'SETUP_DOMAIN') {
  if (domain && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) throw new Error(`${variable} 只接受域名，${variable === 'SETUP_DOMAIN' ? '不含协议、路径或端口' : '不要带 https://、路径或端口'}。`);
}
export async function setup(argv = process.argv.slice(2), { root = PROJECT_ROOT, env = process.env, platform = process.platform, procVersion, prompts, run = runProcess, portCheck = checkPort, ready = waitReady, log = console.log, output = text => process.stdout.write(text) } = {}) {
  checkRuntimeEnvironment({ platform, procVersion, root });
  const options = parseSetup(argv), exists = fs.existsSync(path.join(root, '.env'));
  if (exists && !options.reconfigure) { log('已配置；要重新生成请先备份并删除 .env'); return; }
  if (!exists && options.reconfigure) throw new Error('尚未配置，请先运行 npm run setup。');
  const previous = exists ? readEnv(root) : {};
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/models.json'), 'utf8'));
  const models = Object.keys(catalog.models).filter(id => catalog.models[id].purposes.includes('chat'));
  if (options.interactive) prompts ??= createPrompts();
  let values, username, password;
  const askValid = async (read, validate) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 只重问校验失败的输入；取消或读取失败仍直接交给调用方处理。
      const value = await read();
      try { validate(value); return value; }
      catch (error) { log(error.message); }
    }
    throw new Error(`已连续 3 次输入无效，配置未写入；请重新运行 npm run setup${options.reconfigure ? ' -- --reconfigure-model' : ''}。`);
  };
  try {
    let model = env.CODEX_MODEL || previous.CODEX_MODEL || 'deepseek/deepseek-flash';
    if (options.interactive) {
      log('接下来依次填写：对话模型 → API Key（输入时不显示）' + (options.reconfigure ? '。' : '→ 对外域名（可跳过）→ 管理员账号。'));
      log('选择对话模型：');
      log(models.map((id, i) => `${i + 1}. ${id}`).join('\n'));
      model = await askValid(async () => {
        const answer = (await prompts.ask(`输入编号或模型名称，直接回车使用 ${model}：`)).trim();
        return answer ? (/^\d+$/.test(answer) ? models[+answer - 1] : answer) : model;
      }, value => {
        if (!models.includes(value)) throw new Error(`没有这个选项，请输入 1–${models.length} 的编号或列表中的模型名称`);
      });
      log(`已选择 ${model}`);
    }
    if (!models.includes(model)) throw new Error('CODEX_MODEL 必须是 config/models.json 中用途含 chat 的模型。');
    const keyEnv = catalog.providers[model.split('/')[0]].keyEnv;
    const key = options.interactive ? await prompts.ask(`${keyEnv}（输入时不显示；粘贴后按回车，留空可稍后再填）：`, { secret: true }) : env[keyEnv] || '';
    if (options.interactive) log(key || previous[keyEnv] ? `已记录 ${keyEnv}` : `未填写 ${keyEnv}，稍后运行 npm run setup -- --reconfigure-model 补上`);
    else if (!key && !previous[keyEnv]) log(`尚未填写 ${keyEnv}；服务可能无法就绪，稍后请运行 npm run setup -- --reconfigure-model。`);
    const updates = { CODEX_MODEL: model, CODEX_MODEL_CATALOG_ENABLED: 'true', [keyEnv]: key || previous[keyEnv] || '' };
    const summary = `模型 ${model}；API Key ${updates[keyEnv] ? '已填写' : '未填写'}`;
    if (options.reconfigure) {
      values = { ...previous, ...updates };
      if (options.interactive) log(`${summary}；域名及管理员沿用现有配置`);
    }
    else {
      let domain;
      if (options.interactive) {
        domain = await askValid(async () => (await prompts.ask('对外域名（本机使用直接回车跳过）：')).trim(), value => validateDomain(value, '域名'));
        username = await askValid(async () => (await prompts.ask('管理员用户名（直接回车使用 admin）：')).trim() || 'admin', value => validateUsername(value, '用户名'));
        const pair = await askValid(async () => [
          await prompts.ask('管理员密码（至少 12 位，输入时不显示）：', { secret: true }),
          await prompts.ask('再次输入管理员密码：', { secret: true }),
        ], ([value, confirmation]) => {
          validatePassword(value, '密码');
          if (value !== confirmation) throw new Error('两次密码不一致。');
        });
        password = pair[0];
      } else {
        domain = (env.SETUP_DOMAIN || '').trim();
        validateDomain(domain);
        username = env.SETUP_ADMIN_USER || 'admin';
        password = env.SETUP_ADMIN_PASSWORD;
        validateUsername(username); validatePassword(password);
      }
      const template = parseEnv(fs.readFileSync(path.join(root, '.env.example'), 'utf8'));
      values = generateDeployEnv(updates, template, path.resolve(root));
      values.AGENT_ALLOWED_ORIGINS = `http://127.0.0.1:4317,http://localhost:4317${domain ? `,https://${domain}` : ''}`;
      if (options.interactive) log(`${summary}；域名 ${domain || '无'}；管理员 ${username}`);
    }
  } finally { prompts?.close(); }
  validateClusterSecrets(values, clusterNodes(values));
  const redact = await commandRedactor(env, previous, values, { SETUP_ADMIN_PASSWORD: password });
  const childEnv = childEnvironment(env), execute = (command, args, extra = {}) => run(command, args, { root, env: childEnv, output, redact, quiet: options.quiet, ...extra });
  if (options.start) {
    log('检查 Docker Compose、Docker 运行状态与入口端口……');
    await checkDocker({ platform, root, env, run });
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
