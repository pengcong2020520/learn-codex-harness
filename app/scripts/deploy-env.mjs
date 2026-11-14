import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { clusterNodes } from '../server/modules/config/cluster.mjs';
import { isMain, serializeEnv } from './quickstart-lib.mjs';

export function nodeSecrets(nodes) {
  const values = {};
  for (const node of nodes.map(id => id.slice(-1).toUpperCase())) {
    const key = randomBytes(32).toString('hex');
    values[`AGENT_NODE_KEY_${node}`] = key;
    values[`AGENT_NODE_KEY_${node}_HASH`] = createHash('sha256').update(key).digest('hex');
    values[`AGENT_NODE_${node}_DB_PASSWORD`] = randomBytes(24).toString('hex');
    values[`ETCD_NODE_${node}_PASSWORD`] = randomBytes(24).toString('hex');
  }
  return values;
}
export function generateDeployEnv(env, template, directory) {
  const values = Object.fromEntries(Object.keys(template).map(key => [key, env[key] ?? template[key]]));
  Object.assign(values, nodeSecrets(clusterNodes(values)));
  values.AGENT_PREVIEW_SECRET = randomBytes(32).toString('hex');
  values.AGENT_DB_PASSWORD = randomBytes(24).toString('hex');
  values.REDIS_PASSWORD = randomBytes(24).toString('hex');
  values.ETCD_ROOT_PASSWORD = randomBytes(24).toString('hex');
  values.ETCD_HEALTH_PASSWORD = randomBytes(24).toString('hex');
  values.AGENT_GATEWAY_KEY = `sk-bf-${randomBytes(24).toString('hex')}`;
  values.CONTAINER_APP_DIR = directory;
  values.AGENT_PORT = env.AGENT_PORT || '4317';
  return values;
}
// 此入口只供 remote.sh 管道传输；拒绝直接输出到终端。
if (isMain(import.meta.url)) {
  try {
    if (process.stdout.isTTY) throw new Error('配置只能经管道传输，不能打印到终端。');
    const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
    const template = parseEnv(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
    if (!process.argv[2]) throw new Error('缺少 CONTAINER_APP_DIR。');
    process.stdout.write(serializeEnv(generateDeployEnv(env, template, process.argv[2])));
  } catch { console.error('部署配置生成失败，请检查 .env 与 CONTAINER_APP_DIR；内容未显示。'); process.exitCode = 1; }
}
