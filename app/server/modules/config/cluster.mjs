import { createHash } from 'node:crypto';
// One topology parser for server configuration and deployment tooling.
export function clusterNodes(env = {}) {
  const value = env.AGENT_CLUSTER_NODES ?? 'node-a';
  if (!['node-a', 'node-a,node-b', 'node-a,node-b,node-c'].includes(value))
    throw new Error('AGENT_CLUSTER_NODES 只能是 node-a、node-a,node-b 或 node-a,node-b,node-c（顺序固定）。');
  return Object.freeze(value.split(','));
}
export function assertClusterOwners(rows, nodes) {
  if (rows.some(row => [row.node_id, row.replica].some(id => id && !nodes.includes(id))))
    throw new Error('集群节点只能增加；要移除节点先用 move/promote 迁走分片');
}
export function validateClusterSecrets(env, nodes) {
  const invalid = new Set();
  const nonempty = name => { if (typeof env[name] !== 'string' || !env[name].trim()) invalid.add(name); };
  for (const id of nodes) {
    const suffix = id.slice(-1).toUpperCase();
    const key = `AGENT_NODE_KEY_${suffix}`, hash = `${key}_HASH`;
    if (typeof env[key] !== 'string' || env[key].length < 24) invalid.add(key);
    if (!/^[a-f0-9]{64}$/.test(env[hash] || '') || typeof env[key] !== 'string' ||
        env[hash] !== createHash('sha256').update(env[key]).digest('hex')) invalid.add(hash);
    nonempty(`ETCD_NODE_${suffix}_PASSWORD`);
    const password = `AGENT_NODE_${suffix}_DB_PASSWORD`;
    if (!/^[a-zA-Z0-9_-]+$/.test(env[password] || '')) invalid.add(password);
  }
  for (const name of ['ETCD_ROOT_PASSWORD', 'ETCD_HEALTH_PASSWORD', 'AGENT_DB_PASSWORD', 'REDIS_PASSWORD', 'AGENT_GATEWAY_KEY']) nonempty(name);
  if (invalid.size) throw new Error(`集群配置检查失败，请检查变量：${[...invalid].join('、')}`);
}
export function clusterUpstreams(nodes, env = {}) {
  return nodes.map(id => id === 'node-b' && env.NODE_B_UPSTREAM ? env.NODE_B_UPSTREAM : `${id}:${4340 + nodes.indexOf(id)}`).join(' ');
}
