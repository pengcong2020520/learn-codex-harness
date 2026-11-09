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
 const env={...process.env,PATH:root+':'+process.env.PATH,SSH_USER:'codex-tunnel',NODE_ID:'node-b'};
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
