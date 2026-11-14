import { nodeAuth, authHeaders } from './fixtures/node-auth.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
const user='00000000-0000-4000-8000-000000000017';
test('真实 HTTP：任意节点登录、POST 代理、STALE_ROUTE 一次重试、SSE 断开及 unavailable', {timeout:15000},async t=>{
  const members=new Map();let sourceClosed=false,handled=0,refreshes=0,seenLastId;
  const caches=[0,1].map(()=>({revision:'1',routeOf(){return {shardId:'1',primary:'node-b',epoch:1,revision:this.revision};},refresh:async()=>{}}));
  caches[1].revision='0';caches[0].refresh=async()=>{refreshes++;caches[0].revision=caches[1].revision='2';};
  const addresses=[];
  for(const [n,nodeId] of ['node-a','node-b'].entries()){
    const coordination={members,checkLease:()=>true};
    const runtime={nodeId,...nodeAuth(nodeId),cache:caches[n],coordination,admit:async()=>{}};
    const app={data:{pool:{query:async()=>({rows:[{exists:1}]})}},accounts:{authenticate:async authorization=>{if(authorization!=='Bearer test')throw Object.assign(new Error('unauthorized'),{status:401});return {userId:user,role:'user'};}},http:{handle:async(req,res)=>{
      if(req.url==='/auth/login'){res.writeHead(200);res.end('{"login":true}');return;}
      if(req.url==='/events'){
        handled++;seenLastId=req.headers['last-event-id'];res.writeHead(200,{'content-type':'text/event-stream'});res.write('id: primary:18\ndata: {}\n\n');res.once('close',()=>{sourceClosed=true;});return;
      }
      handled++;const chunks=[];for await(const c of req)chunks.push(c);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({nodeId,body:Buffer.concat(chunks).toString()}));
    }}};
    const handler=createShardedHandler(coordination,{isReady:()=>true,app},runtime,{});
    const server=createServer((req,res)=>{void handler(req,res);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const address=`http://127.0.0.1:${server.address().port}`;members.set(nodeId,{nodeId,address});addresses.push(address);
  }
  const headers={authorization:'Bearer test','content-type':'application/json'};
  assert.equal((await fetch(addresses[0]+'/auth/login',{method:'POST',body:'{}'})).status,200);
  const response=await fetch(addresses[0]+'/messages',{method:'POST',headers,body:'{"text":"hello"}'});
  assert.deepEqual(await response.json(),{nodeId:'node-b',body:'{"text":"hello"}'});assert.equal(refreshes,1);assert.equal(handled,1);
  const sse=await fetch(addresses[0]+'/events',{headers:{...headers,'last-event-id':'primary:17'}});const reader=sse.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'id: primary:18\ndata: {}\n\n');assert.equal(seenLastId,'primary:17');await reader.cancel();
  for(let n=0;n<100&&!sourceClosed;n++)await delay(10);assert.ok(sourceClosed);
  members.delete('node-b');const down=await fetch(addresses[0]+'/messages',{method:'POST',headers,body:'{}'});assert.equal(down.status,503);assert.equal((await down.json()).error.code,'SHARD_UNAVAILABLE');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHttpService } from '../server/modules/http/index.mjs';
import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { previewHeaders } from '../server/modules/http/previews.mjs';

test('真实分片 HTTP：非主节点校验预览令牌后按用户转发，主节点无须 Authorization 读取', async t => {
  const members = new Map(), nodes = [], secret = randomBytes(32).toString('hex');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-shard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let reads = 0, authentications = 0;
  for (const nodeId of ['node-a', 'node-b']) {
    const workspace = path.join(root, nodeId); fs.mkdirSync(workspace);
    const files = createUserFileTools(root, { workspaceDir: workspace, sources: [{ id: 'output', locator: 'outputs', actions: ['read'] }], outputs: { directory: 'outputs', formats: ['html'] } });
    if (nodeId === 'node-b') runOwner(user, () => files.write_file({ path: 'outputs/page.html', content: '<html>主节点文件</html>' }));
    const original = files.read_preview;
    files.read_preview = args => { assert.equal(nodeId, 'node-b'); reads++; return original(args); };
    const coordination = { members, checkLease: () => true };
    const runtime = { nodeId, ...nodeAuth(nodeId), coordination, admit: async owner => assert.equal(owner, user),
      cache: { revision: '1', routeOf(owner) { assert.equal(owner, user); return { shardId: '1', primary: 'node-b', epoch: 1, revision: '1' }; } } };
    const config = { previewSecret: secret, deployment: { rateLimit: 20 }, allowedOrigins: ['https://example.com'] };
    const accounts = { authenticate: async authorization => {
      authentications++; if (authorization !== 'Bearer test') throw Object.assign(new Error('请登录。'), { status: 401 });
      return { userId: user };
    } };
    const http = createHttpService({ config, accounts, files, sessions: {}, redact: JSON.stringify });
    const app = { config, accounts, http, data: { pool: { query: async () => ({ rows: [{ exists: 1 }] }) } } };
    const handler = createShardedHandler(coordination, { isReady: () => true, app }, runtime, {});
    const server = createServer((req, res) => void handler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const address = `http://127.0.0.1:${server.address().port}`;
    members.set(nodeId, { nodeId, address }); nodes.push({ address, http });
  }
  const created = await fetch(nodes[0].address + '/previews', { method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ path: 'outputs/page.html' }) });
  assert.equal(created.status, 200); const preview = await created.json(), before = authentications;
  const response = await fetch(nodes[0].address + preview.url);
  assert.equal(response.status, 200); assert.equal(await response.text(), '<html>主节点文件</html>');
  assert.equal(authentications, before); assert.equal(reads, 2);
  for (const [name, value] of Object.entries(previewHeaders('outputs/page.html'))) assert.equal(response.headers.get(name), value);
  assert.equal((await fetch(nodes[0].address + preview.url, { headers: { origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await fetch(nodes[0].address + preview.url + 'tamper')).status, 404); assert.equal(reads, 2);
  // 有效、无效预览均使用入口节点的来源限额，不能借转发绕过。
  nodes[0].http.limits.rateLimit = 2;
  assert.equal((await fetch(nodes[0].address + preview.url)).status, 429);
});
