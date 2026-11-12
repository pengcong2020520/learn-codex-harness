import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { ReplicationRateLimiter, replicationRateLimit, progressTimeout, sendArchive } from '../server/modules/replication/transport.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { tempRoot } from './helpers.mjs';

for(const stalled of [false,true])test(`发送进度超时：${stalled?'30 秒无 socket 写出进展中止':'持续进展累计 60 秒不受总时长限制'}`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const root=tempRoot(t),file=path.join(root,'snapshot.tar');fs.writeFileSync(file,Buffer.alloc(3*65536));
 let bytes=0,aborted=false;
 t.mock.method(http,'request',(url,options)=>{
  const req=new EventEmitter();
  options.signal.addEventListener('abort',()=>{aborted=true;req.emit('error',options.signal.reason);},{once:true});
  req.write=(chunk,callback)=>{
   t.mock.timers.tick(stalled?30000:20000);
   if(aborted)callback(options.signal.reason);else{bytes+=chunk.length;callback();}
  };
  req.end=()=>{const res=Readable.from(['{}']);res.statusCode=200;req.emit('response',res);};
  req.destroy=()=>{req.destroyed=true;};return req;
 });
 const sending=sendArchive(new URL('http://replica.invalid/tree'),file,{limiter:new ReplicationRateLimiter(0)});
 if(stalled){await assert.rejects(sending,/30 秒/);assert.equal(bytes,0);}
 else{await sending;assert.equal(bytes,3*65536);}
});
test('进度计时器每块重置，恰好 30000ms 无进展触发，关闭移除计时',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const watch=progressTimeout();
 for(let n=0;n<5;n++){t.mock.timers.tick(29999);assert.equal(watch.signal.aborted,false);watch.progress();}
 t.mock.timers.tick(29999);assert.equal(watch.signal.aborted,false);t.mock.timers.tick(1);assert.equal(watch.signal.aborted,true);watch.close();
 const closed=progressTimeout();closed.close();t.mock.timers.tick(60000);assert.equal(closed.signal.aborted,false);
});
test('节点共享限速器：N 字节至少 N/速率；多目标共享额度，0 不限速',async()=>{
 let now=0,total=0;const reservations=[];
 const limiter=new ReplicationRateLimiter(100,{now:()=>now,sleep:async ms=>{reservations.push(ms);}});
 await Promise.all([limiter.take(100),limiter.take(200),limiter.take(100)]);
 assert.deepEqual(reservations,[1000,3000,4000]);
 const serial=new ReplicationRateLimiter(100,{now:()=>now,sleep:async ms=>{now+=ms;}});
 for(const bytes of [1,24,75,99,301]){total+=bytes;await serial.take(bytes);assert.ok(now>=total/100*1000);}
 const unlimited=new ReplicationRateLimiter(0,{sleep:async()=>assert.fail('0 must not wait')});await unlimited.take(1e9);
});
test('AGENT_REPLICATION_RATE_LIMIT 缺省为 0，非法值在启动配置阶段失败',t=>{
 const root=tempRoot(t);assert.equal(replicationRateLimit({}),0);assert.equal(replicationRateLimit({AGENT_REPLICATION_RATE_LIMIT:'262144'}),262144);
 for(const rate of ['', '-1','1.5','NaN','Infinity','1e3',' 2','0x10','9007199254740992'])
  assert.throws(()=>loadServerConfig(root,{AGENT_REPLICATION_RATE_LIMIT:rate}),/AGENT_REPLICATION_RATE_LIMIT/);
});

test('接收 tree 无整体时限且保留 30s 无活动超时；小请求仍为整体 30s',async t=>{
 const { configureReplicationTimeouts }=await import('../server/modules/replication/request-timeout.mjs');
 t.mock.timers.enable({apis:['setTimeout']});
 const server=configureReplicationTimeouts(new EventEmitter());assert.equal(server.requestTimeout,0);assert.equal(server.headersTimeout,10000);
 const create=url=>{
  const req=new EventEmitter(),res=new EventEmitter();req.method='PUT';req.url=url;
  req.destroy=()=>{req.destroyed=true;req.emit('close');};
  req.setTimeout=(ms,fn)=>{req.timeout=ms;if(fn)req.on('timeout',fn);};
  server.emit('request',req,res);return req;
 };
 const tree=create('/internal/replication/tree?kind=home'),content=create('/internal/replication/content');
 assert.equal(tree.timeout,30000);t.mock.timers.tick(30000);assert.equal(content.destroyed,true);
 t.mock.timers.tick(60000);assert.equal(tree.destroyed,undefined);
 tree.emit('timeout');assert.equal(tree.destroyed,true);assert.equal(tree.timeout,0);
 const done=create('/internal/replication/publish');done.emit('end');t.mock.timers.tick(60000);assert.equal(done.destroyed,undefined);
});
