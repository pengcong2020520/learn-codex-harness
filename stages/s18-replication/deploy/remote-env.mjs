// Run on the control host; redirect stdout into a 0600 file, then scp it privately.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
const env=parseEnv(fs.readFileSync(new URL('../.env',import.meta.url),'utf8'));
const node=process.env.NODE_ID||'node-b',suffix=node.slice(-1).toUpperCase();
if(!/^node-[abc]$/.test(node))throw Error('Invalid node');
const port=4340+'abc'.indexOf(node.slice(-1));
const database=new URL('postgresql://agent_node_'+suffix.toLowerCase()+'@127.0.0.1:15432/agent_s18');database.password=env[`AGENT_NODE_${suffix}_DB_PASSWORD`];
const redis=new URL('redis://127.0.0.1:16379/0');redis.password=env.REDIS_PASSWORD;
const out={APP_DIR:'/opt/s18-replication',AGENT_NODE_ID:node,AGENT_PORT:String(port),AGENT_NODE_ADDRESS:`http://host.docker.internal:${port}`,
 AGENT_NODE_KEY:env['AGENT_NODE_KEY_'+suffix],ETCD_ENDPOINT:'http://127.0.0.1:12379',ETCD_USERNAME:node,ETCD_PASSWORD:env[`ETCD_NODE_${suffix}_PASSWORD`],
 DATABASE_URL:database.href,REDIS_URL:redis.href,AGENT_GATEWAY_URL:'http://127.0.0.1:18080/v1',AGENT_GATEWAY_KEY:env.AGENT_GATEWAY_KEY,
 AGENT_REPLICATION_RATE_LIMIT:'262144',AGENT_DATABASE_CONNECT_TIMEOUT_MS:'15000',AGENT_DATABASE_IDLE_TX_TIMEOUT_MS:'60000',AGENT_ETCD_RPC_TIMEOUT_MS:'10000',AGENT_DATABASE_POOL_MAX:'16',AGENT_REDIS_TIMEOUT_MS:'10000',AGENT_REQUEST_TIMEOUT_MS:'120000',AGENT_RUNTIME_LIMIT:'2',CODEX_MODEL_CATALOG_ENABLED:'true',CODEX_MODEL:env.CODEX_MODEL||'kimi/kimi-k2.7-code',AGENT_DEFINITION:env.AGENT_DEFINITION||'agents/writing/agent.json'};
for(const n of ['A','B','C'])out[`AGENT_NODE_KEY_${n}_HASH`]=env[`AGENT_NODE_KEY_${n}_HASH`];
for(const [key,value] of Object.entries(out)) {
 if(!value||/[\r\n'\\]/.test(value))throw Error('Missing or invalid '+key);
 process.stdout.write(`${key}=${value}\n`);
}
