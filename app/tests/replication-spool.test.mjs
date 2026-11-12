import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ReplicationSpool } from '../server/modules/replication/spool.mjs';
import { ReplicationWorker } from '../server/modules/replication/worker.mjs';
import { transferLimit } from '../server/modules/sharding/transfer.mjs';
import { tempRoot } from './helpers.mjs';
const record={user_id:'11111111-1111-4111-8111-111111111111',uid:10001};
const exporter=(root,row,kind,options)=>{
 assert.equal(row,record);assert.equal(options.maxBytes,transferLimit());
 return {stream:Readable.from([kind+' captured bytes']),done:Promise.resolve(),stop:async()=>{}};
};
test('暂存目录：启动清理遗留；服务属主目录 0700、tar 0600，内容固定',async t=>{
 const root=tempRoot(t),old=path.join(root,'.runs/replication-spool',record.user_id,'stale');
 fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'home.tar'),'old');
 const spool=new ReplicationSpool(root,{exporter});assert.equal(fs.existsSync(old),false);
 const token=randomUUID(),files=[{file:'immutable',kind:'blob'}];
 const snapshot=await spool.capture(record,token,async()=>({hash:'boundary hash',files}));
 for(const dir of [spool.directory,path.join(spool.directory,record.user_id),path.dirname(snapshot.archives.home)]){
  const stat=fs.statSync(dir);assert.equal(stat.mode&0o777,0o700);assert.equal(stat.uid,process.getuid());
 }
 for(const kind of ['home','workspace']){
  const stat=fs.statSync(snapshot.archives[kind]);assert.equal(stat.mode&0o777,0o600);assert.equal(stat.uid,process.getuid());
  assert.equal(fs.readFileSync(snapshot.archives[kind],'utf8'),kind+' captured bytes');
 }
 assert.equal(snapshot.hash,'boundary hash');assert.deepEqual(snapshot.files,files);
 await snapshot.close();assert.equal(fs.existsSync(path.dirname(snapshot.archives.home)),false);
});
test('快照导出或哈希失败也删除 token 暂存目录',async t=>{
 for(const failAt of ['workspace','describe']){
  const root=tempRoot(t),spool=new ReplicationSpool(root,{exporter:(...args)=>{
   if(args[2]===failAt)throw Error('export failed');return exporter(...args);
  }}),token=randomUUID();
  await assert.rejects(spool.capture(record,token,async()=>{throw Error('hash failed');}),/failed/);
  assert.equal(fs.existsSync(path.join(spool.directory,record.user_id,token)),false);
 }
});
for(const outcome of ['success','failure','shutdown'])test(`暂存目录：worker ${outcome} 后删除 token，关闭中止发送`,async t=>{
 const root=tempRoot(t),spool=new ReplicationSpool(root,{exporter}),entered=Promise.withResolvers();let archive;
 const route={replica:'node-b',epoch:1,shardId:'0'};
 const worker=new ReplicationWorker({runtime:{cache:{routeOf:()=>route},owns:()=>true,coordination:{members:new Map([['node-b',{}]])}},
  store:{boundary:async()=>({busy:0,sequence:'2'}),position:async()=>null,unfinished:async()=>false,begin:async()=>{},finish:async()=>{},fail:async()=>{}},
  quiesce:async()=>true,release:async()=>{},log(){},
  snapshot:async(user,token)=>{archive=await spool.capture(record,token,async()=>({hash:'a',files:[]}));return archive;},
  send:async(user,route,token,snapshot,signal)=>{
   assert.ok(fs.existsSync(snapshot.archives.home));entered.resolve();
   if(outcome==='failure')throw Error('failed');
   if(outcome==='shutdown')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
 const work=worker.sync(record.user_id);const result=outcome==='success'?work:assert.rejects(work,outcome==='failure'?/failed/:/关闭/);
 await entered.promise;if(outcome==='shutdown')await worker.close();await result;await worker.close();
 assert.equal(fs.existsSync(path.dirname(archive.archives.home)),false);
});
test('哈希未变：先算哈希后短路，不导出 tar、不建暂存目录',async t=>{
 const root=tempRoot(t);let exported=0;
 const spool=new ReplicationSpool(root,{exporter:(...args)=>{exported++;return exporter(...args);}}),token=randomUUID();
 const same=await spool.capture(record,token,async()=>({hash:'h',files:[]}),hash=>hash==='h');
 assert.equal(same.unchanged,true);assert.equal(exported,0);
 assert.equal(fs.existsSync(path.join(spool.directory,record.user_id,token)),false);
 const changed=await spool.capture(record,token,async()=>({hash:'h2',files:[]}),hash=>hash==='h');
 assert.equal(changed.unchanged,undefined);assert.equal(exported,2);await changed.close();
});
