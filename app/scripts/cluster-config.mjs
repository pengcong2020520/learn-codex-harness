import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { clusterNodes, clusterUpstreams, validateClusterSecrets } from '../server/modules/config/cluster.mjs';
let file = {};
try { file = parseEnv(fs.readFileSync('.env', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = { ...file, ...process.env };
try {
  const nodes = clusterNodes(env);
  if (process.argv[2] === 'check') {
    validateClusterSecrets(env, nodes);
    console.log(`集群配置检查通过：${nodes.join('、')}`);
  } else console.log(process.argv[2] === 'upstreams' ? clusterUpstreams(nodes, env) : nodes.join(' '));
} catch (error) { console.error(error.message); process.exitCode = 1; }
