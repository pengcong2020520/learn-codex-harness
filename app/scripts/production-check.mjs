import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { isIP } from 'node:net';
import { loadModelRegistry, splitModelId } from '../server/modules/gateway/index.mjs';
import { clusterNodes } from '../server/modules/config/cluster.mjs';
import { budgetConfig } from '../server/modules/usage/config.mjs';
import { selectAgentFile } from '../server/modules/agents/selection.mjs';
import { archiveFiles, backupName } from './backup-lib.mjs';
import { checkAgent } from './agent-check.mjs';
import { PROJECT_ROOT, isMain } from './quickstart-lib.mjs';

function hasHttpsDomain(value) {
  return (value || '').split(',').some(origin => {
    try {
      const url = new URL(origin.trim()), host = url.hostname.replace(/\.$/, '');
      return url.protocol === 'https:' && url.origin === origin.trim() && host.includes('.')
        && !isIP(host) && !host.endsWith('.localhost') && !host.endsWith('.local');
    } catch { return false; }
  });
}

function latestBackup(root, now) {
  let latest = null;
  const walk = (directory, depth) => {
    if (!fs.lstatSync(directory).isDirectory()) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name);
      try {
        backupName(entry.name);
        const manifestFile = path.join(target, 'manifest.json');
        if (!fs.lstatSync(manifestFile).isFile()) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), time = Date.parse(manifest.time);
        if (!Number.isFinite(time) || time > now) continue;
        if (!archiveFiles.every(name => {
          const info = fs.lstatSync(path.join(target, name));
          return info.isFile() && info.size === manifest.files?.[name]?.size;
        })) continue;
        latest = Math.max(latest ?? 0, time);
      } catch {
        // 只扫描历史单节点目录和当前按节点分层的目录，不跟随链接或进入临时备份。
        if (depth < 1 && /^node-[abc]$/.test(entry.name)) walk(target, depth + 1);
      }
    }
  };
  try { walk(path.join(root, 'backups'), 0); } catch { /* 无权限或没有备份时给建议。 */ }
  return latest;
}

export function checkProduction({ root = PROJECT_ROOT, now = Date.now() } = {}) {
  const rows = [];
  const add = (id, level, title, detail, fix) => rows.push({ id, level, title, detail, fix });
  let env = {}, secure = false, readable = false, fd;
  try {
    fd = fs.openSync(path.join(root, '.env'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error();
    secure = (info.mode & 0o7777) === 0o600;
    env = parseEnv(fs.readFileSync(fd, 'utf8')); readable = true;
  } catch { /* 不输出底层错误，防止包含配置值和路径。 */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const https = hasHttpsDomain(env.AGENT_ALLOWED_ORIGINS);
  add('origins', https ? 'ok' : 'error', 'AGENT_ALLOWED_ORIGINS', https ? '已声明 HTTPS 域名来源；尚未验证 DNS 和证书。' : '没有有效的 HTTPS 域名来源，还只能按本机入口使用。', '查看 README「域名与 HTTPS」，配置后运行 npm run up。');
  add('env-file', readable && secure ? 'ok' : 'error', '.env 文件', readable && secure ? '普通文件，权限为 0600。' : '.env 缺失、不可读、不是独立普通文件或权限不是 0600。', '未初始化时运行 npm run setup；在终端核对文件类型，并运行 chmod 600 .env。');
  const sameDirectory = env.CONTAINER_APP_DIR === path.resolve(root);
  add('deployment-directory', sameDirectory ? 'ok' : 'error', 'CONTAINER_APP_DIR', sameDirectory ? '部署路径与当前目录一致。' : '部署路径不一致；目录搬家会导致旧会话无法恢复。', '查看 README「升级」，核对原部署目录并恢复原路径；不要直接改路径继续运行旧会话。');
  let registry;
  try { registry = loadModelRegistry(root); } catch { /* 统一给出不含配置值的诊断。 */ }
  const model = env.CODEX_MODEL?.trim(), spec = registry?.models[model];
  const hasKey = id => {
    const provider = registry?.providers[splitModelId(id).provider];
    return Boolean(provider?.keyEnv && env[provider.keyEnv]?.trim());
  };
  const defaultReady = Boolean(spec?.purposes.includes('chat') && hasKey(model));
  add('default-model', defaultReady ? 'ok' : 'error', '默认模型与服务商 Key', defaultReady ? '已登记对话模型，服务商 Key 非空；未验证有效性。' : '模型目录、CODEX_MODEL 或其服务商 Key 未配置完整。', '查看 README「配置项参考」和 config/models.json；运行 npm run setup -- --reconfigure-model，由用户在终端输入 Key。');
  const fallback = (spec?.fallbacks || []).some(id => registry.models[id]?.purposes.includes('chat') && hasKey(id));
  add('fallback-model', fallback ? 'ok' : 'warning', '备用模型', fallback ? '备用链至少一个对话模型的服务商 Key 非空；未验证有效性。' : '默认模型的备用链没有已填写 Key 的对话模型。', '查看 README「配置项参考」，在 config/models.json 配置 fallbacks，由用户在终端填写对应 Key。');
  try {
    const budget = budgetConfig(env);
    const limited = ['dailyTokens', 'monthlyTokens', 'dailyCost', 'monthlyCost'].some(key => budget[key] !== null);
    add('budget', limited ? 'ok' : 'warning', 'AGENT_BUDGET_* 预算上限', limited ? '至少设置了一项预算上限。' : '没有设置预算上限。', '查看 README「配置项参考」，由用户在终端设置每日或每月预算，再运行 npm run up。');
  } catch { add('budget', 'error', 'AGENT_BUDGET_* 预算上限', '预算配置格式无效。', '查看 README「配置项参考」，token 上限用非负整数，金额用非负数字，并核对预算时区。'); }
  const backup = latestBackup(root, now), recent = backup !== null && now - backup <= 7 * 86400000;
  add('backup', recent ? 'ok' : 'warning', '备份', backup === null ? '没有找到完整备份记录。' : `最近备份时间：${new Date(backup).toISOString()}${recent ? '，未超过七天。' : '，已超过七天。'}`, '运行 npm run backup；生产环境建议定时执行。查看 README「备份与恢复」，在独立环境演练恢复；本项未核验归档哈希和可恢复性。');
  try {
    const cluster = clusterNodes(env).length > 1;
    add('topology', cluster ? 'ok' : 'warning', '部署拓扑', cluster ? '已配置集群；未验证节点存活和副本接管。' : '单节点没有故障接管。', '需要故障接管时运行 npm run cluster:enable；查看 README「打开集群」。');
  } catch { add('topology', 'error', '部署拓扑', 'AGENT_CLUSTER_NODES 无效。', '查看 README「打开集群」，核对拓扑后再运行 npm run status。'); }
  let agentReady = false;
  try { agentReady = readable && !checkAgent(selectAgentFile(root, env.AGENT_DEFINITION), { root }).some(row => row.level === 'error'); }
  catch { /* 不输出从环境选择的文件路径及底层诊断。 */ }
  add('agent', agentReady ? 'ok' : 'error', '当前 Agent', agentReady ? 'Agent 错误级静态检查通过。' : 'Agent 错误级静态检查未通过，或无法确定当前 Agent。', '运行 npm run agent:check -- <agent.json 路径>；查看 README「做你自己的 Agent」。');
  return rows;
}

export function formatProductionChecks(rows) {
  const symbols = { ok: '✓', error: '✗', warning: '!' };
  return [...rows.map(row => `${symbols[row.level]} ${row.title}：${row.detail}\n  下一步：${row.fix}`),
    '本次仅做静态检查，不探测或启动服务。未检查：服务运行状态、真实登录、真实对话、DNS 与证书、Key 有效性、数据库连接、备份恢复和集群接管。'].join('\n');
}

if (isMain(import.meta.url)) {
  const rows = checkProduction();
  console.log(formatProductionChecks(rows));
  if (rows.some(row => row.level === 'error')) process.exitCode = 1;
}
