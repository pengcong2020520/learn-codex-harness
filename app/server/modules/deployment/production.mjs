import { isIP } from 'node:net';
import { splitModelId } from '../gateway/index.mjs';
import { clusterNodes } from '../config/cluster.mjs';
import { budgetConfig } from '../usage/config.mjs';

function hasHttpsDomain(value) {
  return (value || '').split(',').some(origin => {
    try {
      const url = new URL(origin.trim()), host = url.hostname.replace(/\.$/, '');
      return url.protocol === 'https:' && url.origin === origin.trim() && host.includes('.')
        && !isIP(host) && !host.endsWith('.localhost') && !host.endsWith('.local');
    } catch { return false; }
  });
}

// 判定只依赖显式输入；探测函数由 CLI 或节点准备，不读取文件或全局环境。
export function checkProduction({ env = {}, now, probes = {} }) {
  const items = [], unchecked = [];
  const unavailable = {
    'env-file': !probes.envFile,
    'deployment-directory': !probes.deploymentDirectory,
    'default-model': !probes.providerKey,
    'fallback-model': !probes.providerKey,
    backup: !probes.backup,
    agent: !probes.agent,
  };
  const reasons = {
    'env-file': '节点无法核验宿主 .env 文件类型与权限。',
    'deployment-directory': '节点无法核验宿主实际部署目录。',
    'default-model': '节点不持有服务商 Key，无法核验默认模型的 Key 配置。',
    'fallback-model': '节点不持有服务商 Key，无法核验备用链的 Key 配置。',
    backup: '节点只能看到本节点备份，无法核验部署的完整备份记录。',
    agent: '无法核验当前 Agent 静态配置。',
  };
  const add = (id, level, title, detail, fix) => {
    if (unavailable[id]) unchecked.push({ id, level: 'unchecked', title, detail: reasons[id], fix: '在服务器上运行 docker compose run --rm check 核对' });
    else items.push({ id, level, title, detail, fix });
  };
  const https = hasHttpsDomain(env.AGENT_ALLOWED_ORIGINS);
  const edge = Boolean(env.AGENT_DOMAIN?.trim())
    && (env.COMPOSE_PROFILES || '').split(',').some(profile => ['https', '*'].includes(profile.trim()))
    && (env.AGENT_ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).includes(`https://${env.AGENT_DOMAIN.trim()}`);
  add('origins', https ? (edge ? 'ok' : 'warning') : 'error', 'AGENT_ALLOWED_ORIGINS', https ? (edge ? '已声明匹配的 HTTPS 域名来源并启用入口；尚未验证 DNS 和证书。' : '已声明 HTTPS 来源；需要宿主机反向代理，或启用 https profile。') : '没有有效的 HTTPS 域名来源，还只能按本机入口使用。', '查看 README「域名与 HTTPS」，配置后运行 docker compose up -d。');
  const envFile = probes.envFile?.();
  const readable = envFile?.readable, secure = envFile?.secure;
  add('env-file', readable && secure ? 'ok' : 'error', '.env 文件', readable && secure ? '普通文件，权限为 0600。' : '.env 缺失、不可读、不是独立普通文件或权限不是 0600。', '未初始化时运行 npm run setup；在终端核对文件类型，并运行 chmod 600 .env。');
  // 容器中的只读挂载路径不代表部署路径，目录搬家仍以宿主实际位置判断。
  const sameDirectory = probes.deploymentDirectory?.();
  add('deployment-directory', sameDirectory ? 'ok' : 'error', 'CONTAINER_APP_DIR', sameDirectory ? '部署路径与当前目录一致。' : '部署路径不一致；目录搬家会导致旧会话无法恢复。', '查看 README「升级」，核对原部署目录并恢复原路径；不要直接改路径继续运行旧会话。');
  const registry = probes.registry?.();
  const model = env.CODEX_MODEL?.trim(), spec = registry?.models[model];
  const hasKey = id => {
    const provider = registry?.providers[splitModelId(id).provider];
    return Boolean(provider?.keyEnv && probes.providerKey?.(provider.keyEnv));
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
  const backup = probes.backup?.() ?? null, recent = backup !== null && now - backup <= 7 * 86400000;
  add('backup', recent ? 'ok' : 'warning', '备份', backup === null ? '没有找到完整备份记录。' : `最近备份时间：${new Date(backup).toISOString()}${recent ? '，未超过七天。' : '，已超过七天。'}`, '运行 npm run backup；生产环境建议定时执行。查看 README「备份与恢复」，在独立环境演练恢复；本项未核验归档哈希和可恢复性。');
  try {
    const cluster = clusterNodes(env).length > 1;
    add('topology', cluster ? 'ok' : 'warning', '部署拓扑', cluster ? '已配置集群；未验证节点存活和副本接管。' : '单节点没有故障接管。', '需要故障接管时运行 npm run cluster:enable；查看 README「打开集群」。');
  } catch { add('topology', 'error', '部署拓扑', 'AGENT_CLUSTER_NODES 无效。', '查看 README「打开集群」，核对拓扑后再运行 npm run status。'); }
  const agentReady = probes.agent?.();
  add('agent', agentReady ? 'ok' : 'error', '当前 Agent', agentReady ? 'Agent 错误级静态检查通过。' : 'Agent 错误级静态检查未通过，或无法确定当前 Agent。', '运行 npm run agent:check -- <agent.json 路径>；查看 README「做你自己的 Agent」。');
  return { items, unchecked };
}
