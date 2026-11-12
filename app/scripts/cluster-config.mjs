import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { clusterNodes, clusterUpstreams } from '../server/modules/config/cluster.mjs';
let file = {};
try { file = parseEnv(fs.readFileSync('.env', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = { ...file, ...process.env };
try {
  const nodes = clusterNodes(env);
  console.log(process.argv[2] === 'upstreams' ? clusterUpstreams(nodes, env) : nodes.join(' '));
} catch (error) { console.error(error.message); process.exitCode = 1; }
