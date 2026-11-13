import { createPrompts } from '../shared/prompts.mjs';
import { AgentClient, loadClientConnection } from '../client/modules/connection/index.mjs';
import { clusterNodes, validateClusterSecrets } from '../server/modules/config/cluster.mjs';
import { nodeSecrets } from './deploy-env.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROJECT_ROOT, isMain, readEnv, writeEnv, childEnvironment, commandRedactor, runProcess, composeUp, entryUrl, waitReady } from './quickstart-lib.mjs';

export function parseCluster(argv) {
  let nodes = 'node-a,node-b,node-c', yes = false, quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--yes' && !yes) yes = true;
    else if (argv[i] === '--quiet' && !quiet) quiet = true;
    else if (argv[i] === '--nodes' && argv[i + 1]) nodes = argv[++i];
    else throw new Error('用法：npm run cluster:enable -- [--nodes node-a,node-b] [--yes] [--quiet]。');
  }
  clusterNodes({ AGENT_CLUSTER_NODES: nodes });
  return { nodes, yes, quiet };
}
export function expandCluster(env, requested) {
  const previous = clusterNodes(env), nodes = clusterNodes({ AGENT_CLUSTER_NODES: requested });
  validateClusterSecrets(env, previous);
  if (previous.some(node => !nodes.includes(node))) throw new Error('集群节点只能增加，不能减少。');
  const added = nodes.filter(node => !previous.includes(node));
  const values = { ...env, ...nodeSecrets(added), AGENT_CLUSTER_NODES: nodes.join(','),
    COMPOSE_PROFILES: [...new Set([...(env.COMPOSE_PROFILES || '').split(',').map(s => s.trim()).filter(Boolean), ...(nodes.length > 1 ? ['cluster'] : [])])].join(',') };
  validateClusterSecrets(values, nodes);
  return { values, added };
}
export async function waitReplicas(api, { now = Date.now, wait = sleep, log = console.log } = {}) {
  const deadline = now() + 600_000;
  while (now() < deadline) {
    const status = await api.request('/cluster');
    const shards = status.shards || [], ready = shards.filter(shard => shard.replica && shard.replica_ready === true && !shard.replica_lagging).length;
    log(`副本追平进度：${ready}/${shards.length} 个分片。`);
    if (shards.length === 3 && ready === shards.length && !status.waiting) return;
    await wait(5000);
  }
  throw new Error('等待副本追平超过 10 分钟；扩容结果待核对，请运行 npm run cluster -- status。');
}
export async function enableCluster(argv = process.argv.slice(2), { root = PROJECT_ROOT, env = process.env, prompts, run = runProcess, api, fetchImpl = fetch, ready = waitReady, wait = waitReplicas, log = console.log, output = text => process.stdout.write(text) } = {}) {
  const options = parseCluster(argv), previous = readEnv(root), { values, added } = expandCluster(previous, options.nodes);
  if (!added.length) { log('节点集未改变，无需扩容。'); return; }
  log(`将新增 ${added.join('、')}，保留已有凭据与数据，重建并重启服务，再等待所有分片副本追平（最多 10 分钟）。`);
  const loginSecrets = {};
  try {
    if (!options.yes) {
      prompts ??= createPrompts();
      if (!/^(y|yes|是)$/i.test((await prompts.ask('确认扩容？[y/N] ')).trim())) { log('已取消，未修改配置。'); return; }
    }
    if (!api) {
      try { api = new AgentClient(loadClientConnection({ AGENT_SERVER_URL: entryUrl(previous) }, root)); }
      catch {
        prompts ??= createPrompts();
        const username = env.SETUP_ADMIN_USER || (env.SETUP_ADMIN_PASSWORD ? 'admin' : (await prompts.ask('管理员用户名 [admin]：')).trim() || 'admin');
        const password = env.SETUP_ADMIN_PASSWORD || await prompts.ask('管理员密码（隐藏输入）：', { secret: true });
        loginSecrets.SETUP_ADMIN_PASSWORD = password;
        const response = await fetchImpl(`${entryUrl(previous)}/auth/login`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('管理员登录失败，尚未修改配置。');
        const result = await response.json();
        loginSecrets.TOKEN = result.token;
        api = new AgentClient({ url: entryUrl(previous), token: result.token });
      }
    }
    // 先经过真实的 admin 门禁，避免停止服务后才发现没有查看集群的权限。
    await api.request('/cluster');
  } finally { prompts?.close(); }
  writeEnv(root, values);
  const childEnv = childEnvironment(env), redact = await commandRedactor(env, previous, values, loginSecrets);
  log('准备新增节点并更新集群配置……');
  await run('bash', ['deploy/configure.sh'], { root, env: childEnv, output, redact, quiet: options.quiet });
  await run('docker', composeUp(values), { root, env: childEnv, output, redact, quiet: options.quiet });
  // 服务重启期间先等只读就绪；权限错误和未知失败不自动重试。
  await ready(values, { fetchImpl, log });
  await wait(api, { log });
  log('集群扩容完成，全部分片副本已追平。');
}
if (isMain(import.meta.url)) enableCluster().catch(() => { console.error('扩容未完成；结果待核对，请检查配置、管理员登录和 npm run status；不要重复发起扩容。'); process.exitCode = 1; });
