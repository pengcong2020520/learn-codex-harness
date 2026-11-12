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
export function clusterUpstreams(nodes, env = {}) {
  return nodes.map(id => id === 'node-b' && env.NODE_B_UPSTREAM ? env.NODE_B_UPSTREAM : `${id}:${4340 + nodes.indexOf(id)}`).join(' ');
}
