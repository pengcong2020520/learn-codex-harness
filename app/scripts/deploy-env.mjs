import { clusterNodes } from '../server/modules/config/cluster.mjs';
// stdout is piped directly into SSH; never print this output or enable shell tracing.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const template = parseEnv(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
const allowed = Object.keys(template);
const values = Object.fromEntries(allowed.filter(key => key in env).map(key => [key, env[key]]));
for (const node of clusterNodes(env).map(id => id.slice(-1).toUpperCase())) {
  const key = randomBytes(32).toString('hex');
  values[`AGENT_NODE_KEY_${node}`] = key;
  values[`AGENT_NODE_KEY_${node}_HASH`] = createHash('sha256').update(key).digest('hex');
}
values.AGENT_DB_PASSWORD = randomBytes(24).toString('hex');
for (const node of clusterNodes(env).map(id => id.slice(-1).toUpperCase())) values[`AGENT_NODE_${node}_DB_PASSWORD`] = randomBytes(24).toString('hex');
values.REDIS_PASSWORD = randomBytes(24).toString('hex');
values.ETCD_ROOT_PASSWORD = randomBytes(24).toString('hex');
values.ETCD_HEALTH_PASSWORD = randomBytes(24).toString('hex');
for (const node of clusterNodes(env).map(id => id.slice(-1).toUpperCase())) values[`ETCD_NODE_${node}_PASSWORD`] = randomBytes(24).toString('hex');
values.AGENT_GATEWAY_KEY = `sk-bf-${randomBytes(24).toString('hex')}`;
values.CONTAINER_APP_DIR = process.argv[2];
values.AGENT_PORT = env.AGENT_PORT || '4317';
for (const [key, value] of Object.entries(values)) {
  if (/[\r\n"\\]/.test(value)) throw new Error(`环境变量 ${key} 含不支持的字符。`);
  process.stdout.write(`${key}="${value}"\n`);
}
