import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tempRoot} from './helpers.mjs';
const file=name=>fileURLToPath(new URL('../'+name,import.meta.url));
test('relay 缺省或空 RELAY_BIND 拒绝启动；显式绑定通过',()=>{
 for(const bind of [undefined,'','invalid','127.0.0.1']) {
  const env={...process.env,RELAYS:'[]'};delete env.RELAY_BIND;if(bind!==undefined)env.RELAY_BIND=bind;
  const result=spawnSync(process.execPath,[file('deploy/tcp-relay.mjs')],{env,encoding:'utf8'});
  assert.equal(result.status===0,bind==='127.0.0.1');if(bind!=='127.0.0.1')assert.match(result.stderr,/RELAY_BIND/);
 }
 const compose=fs.readFileSync(file('compose.yaml'),'utf8');
 assert.match(compose,/RELAY_BIND: \$\{REMOTE_BRIDGE_GATEWAY:-172\.29\.18\.1\}/);
 assert.match(compose,/RELAY_BIND: 0\.0\.0\.0/);
});
test('隧道打印限制公钥行，默认专用账号，拒绝 root',t=>{
 const root=tempRoot(t),mock=path.join(root,'ssh-keygen');
 fs.writeFileSync(mock,'#!/bin/sh\nprintf "ssh-ed25519 AAAATEST\\n"\n',{mode:0o755});
 const env={...process.env,PATH:root+':'+process.env.PATH,SSH_USER:'codex-tunnel',NODE_ID:'node-b',AGENT_CLUSTER_NODES:'node-a,node-b,node-c'};
 const script=fs.readFileSync(file('deploy/remote-node.sh'),'utf8');
 assert.match(script,/User=codex-tunnel\nGroup=codex-tunnel/);
 assert.match(script,/--shell \/usr\/sbin\/nologin codex-tunnel/);
 const result=spawnSync('bash',[file('deploy/remote-node.sh'),'--authorized-key'],{env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/^restrict,port-forwarding,permitopen="127.0.0.1:12379"/);
 for(const port of [15432,16379,18080,14340,14342])assert.ok(result.stdout.includes(`permitopen="127.0.0.1:${port}"`));
 assert.match(result.stdout,/permitlisten="127.0.0.1:14341",command="\/bin\/false" ssh-ed25519 AAAATEST/);
 assert.notEqual(spawnSync('bash',[file('deploy/remote-node.sh'),'--authorized-key'],{env:{...env,SSH_USER:'root'}}).status,0);
});

test('两台部署：remote-env 输出 262144 字节/秒，compose 三节点继承限速变量',t=>{
 const root=tempRoot(t);fs.mkdirSync(path.join(root,'deploy'));
 fs.mkdirSync(path.join(root,'server/modules/config'),{recursive:true});fs.copyFileSync(new URL('../server/modules/config/cluster.mjs',import.meta.url),path.join(root,'server/modules/config/cluster.mjs'));
  fs.copyFileSync(file('deploy/remote-env.mjs'),path.join(root,'deploy/remote-env.mjs'));
 fs.writeFileSync(path.join(root,'.env'),['AGENT_CLUSTER_NODES=node-a,node-b,node-c',
  'AGENT_NODE_B_DB_PASSWORD=test-password','REDIS_PASSWORD=test-redis','AGENT_NODE_KEY_B=test-node-key',
  'ETCD_NODE_B_PASSWORD=test-etcd','AGENT_GATEWAY_KEY=test-gateway',
  ...['A','B','C'].map(n=>`AGENT_NODE_KEY_${n}_HASH=${'a'.repeat(64)}`),
 ].join('\n'));
 const result=spawnSync(process.execPath,[path.join(root,'deploy/remote-env.mjs')],{env:{...process.env,NODE_ID:'node-b'},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/^AGENT_REPLICATION_RATE_LIMIT=262144$/m);assert.match(result.stdout,/^AGENT_DATABASE_CONNECT_TIMEOUT_MS=15000$/m);assert.match(result.stdout,/^AGENT_DATABASE_IDLE_TX_TIMEOUT_MS=60000$/m);assert.match(result.stdout,/^AGENT_ETCD_RPC_TIMEOUT_MS=10000$/m);assert.match(result.stdout,/^AGENT_DATABASE_POOL_MAX=16$/m);assert.match(result.stdout,/^AGENT_REDIS_TIMEOUT_MS=10000$/m);assert.match(result.stdout,/^AGENT_REQUEST_TIMEOUT_MS=120000$/m);
 const compose=fs.readFileSync(file('compose.yaml'),'utf8');
 assert.match(compose,/AGENT_REPLICATION_RATE_LIMIT: \$\{AGENT_REPLICATION_RATE_LIMIT:-0\}/);
 for(const node of ['node-b','node-c'])assert.match(compose,new RegExp(`  ${node}:[\\s\\S]*?environment:\\n      <<: \\*node-env`));
});

test('跨地域超时：默认值不变；可调；越界或非整数启动失败',async()=>{
 const { connectTimeout, idleTransactionTimeout } = await import('../server/modules/data/database.mjs');
 const { etcdRpcTimeout } = await import('../server/modules/coordination/etcd.mjs');
 assert.equal(idleTransactionTimeout({}),15000);assert.equal(etcdRpcTimeout({}),3000);
 assert.equal(idleTransactionTimeout({AGENT_DATABASE_IDLE_TX_TIMEOUT_MS:'60000'}),60000);assert.equal(etcdRpcTimeout({AGENT_ETCD_RPC_TIMEOUT_MS:'10000'}),10000);
 assert.throws(()=>etcdRpcTimeout({AGENT_ETCD_RPC_TIMEOUT_MS:'30001'}),/1000–30000/);
 const { redisTimeout } = await import('../server/modules/data/queue.mjs');
 assert.equal(redisTimeout({}),2000);
 const { requestTimeout } = await import('../server/modules/sharding/routing.mjs');
 assert.equal(requestTimeout({}),30000);assert.equal(requestTimeout({AGENT_REQUEST_TIMEOUT_MS:'120000'}),120000);assert.equal(redisTimeout({AGENT_REDIS_TIMEOUT_MS:'10000'}),10000);
 assert.equal(connectTimeout({}),3000);assert.equal(connectTimeout({AGENT_DATABASE_CONNECT_TIMEOUT_MS:'15000'}),15000);
 for(const bad of ['999','60001','1.5','abc',''])assert.throws(()=>connectTimeout({AGENT_DATABASE_CONNECT_TIMEOUT_MS:bad}),/1000–60000/);
});
