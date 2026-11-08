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
    const runtime={nodeId,key:'integration-node-key-123456789',cache:caches[n],coordination,admit:async()=>{}};
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
