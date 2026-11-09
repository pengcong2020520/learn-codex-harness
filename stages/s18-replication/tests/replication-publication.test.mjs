import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ReplicaPublication } from '../server/modules/replication/publication.mjs';
import { tempRoot } from './helpers.mjs';
function fixture(t) {
 const root=tempRoot(t),p=new ReplicaPublication(root,'user',{});
 p.start('token');
 for(const kind of ['home','workspace','blob']) {
  const target=path.join(root,kind),stage=path.join(root,kind+'-stage');
  if(kind==='blob'){fs.writeFileSync(target,'old');fs.writeFileSync(stage,'new');}
  else for(const [dir,value] of [[target,'old'],[stage,'new']]){fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'value'),value);}
  p.add({kind,target,stage,...(kind==='blob'?{file:'content'}:{})});
 }
 const value=kind=>fs.readFileSync(kind==='blob'?path.join(root,kind):path.join(root,kind,'value'),'utf8');
 return {p,root,value};
}
test('全部暂存及校验后才发布，缺失内容不能移动旧副本',t=>{
 const {p,value}=fixture(t);
 assert.throws(()=>p.publish([{kind:'index',file:'missing'}]),/不完整/);
 assert.equal(value('home'),'old');assert.equal(value('workspace'),'old');
});
test('workspace 发布失败回滚 home 和内容，重试仍能成对发布',t=>{
 const {p,value}=fixture(t),rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(source,target)=>{
  if(source.endsWith('workspace-stage'))throw Object.assign(Error('workspace publish failed'),{code:'EIO'});
  return rename(source,target);
 });
 assert.throws(()=>p.publish([{kind:'blob',file:'content'}]),/workspace publish failed/);t.mock.restoreAll();
 for(const kind of ['home','workspace','blob'])assert.equal(value(kind),'old');
 p.publish([{kind:'blob',file:'content'}]);for(const kind of ['home','workspace','blob'])assert.equal(value(kind),'new');
});
test('位点提交前保留旧副本，失败恢复；重启读取本地记录后也能恢复',async t=>{
 const {p,root,value}=fixture(t);p.publish([]);
 for(const e of p.batch.entries)assert.ok(fs.existsSync(e.previous));
 const restarted=new ReplicaPublication(root,'user',{});await restarted.settle(false);
 for(const kind of ['home','workspace','blob'])assert.equal(value(kind),'old');
 assert.equal(fs.existsSync(p.file),false);
});
test('位点提交成功后才清理旧副本，保留新快照',async t=>{
 const {p,value}=fixture(t);p.publish([]);const backups=p.batch.entries.map(e=>e.previous);
 await p.settle(true);for(const name of backups)assert.equal(fs.existsSync(name),false);
 for(const kind of ['home','workspace','blob'])assert.equal(value(kind),'new');
});

test('hash 子进程拒绝超限目录，顶层 home/tmp 不参与计算',async t=>{
 const {spawnSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const root=path.join(tempRoot(t),'hash-home'),worker=fileURLToPath(new URL('../server/modules/replication/hash-worker.mjs',import.meta.url));
 fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.writeFileSync(path.join(root,'tmp/large'),'x'.repeat(100));
 const run=()=>spawnSync(process.execPath,[worker,root,'home','32'],{encoding:'utf8'});
 assert.equal(run().status,0);fs.writeFileSync(path.join(root,'large'),'x'.repeat(33));
 const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/TRANSFER_TOO_LARGE/);
});

test('真实 worker/store 事务边界：COMMIT 前旧副本仍在，COMMIT 失败恢复整组',async t=>{
 const {ReplicationWorker}=await import('../server/modules/replication/worker.mjs');
 const {ReplicationStore}=await import('../server/modules/replication/store.mjs');
 for(const fail of [false,true]) {
  const {p,value}=fixture(t);let committed=false;const queries=[];
  const db={release(){},async query(sql,args){
   queries.push(sql);
   if(sql.startsWith('INSERT INTO agent_data.replication_positions'))assert.equal(args[5],p.batch.token);
   if(sql==='COMMIT') {
    for(const e of p.batch.entries)assert.ok(fs.existsSync(e.previous),'backup retained until PG COMMIT');
    if(fail)throw Error('PG COMMIT failed');committed=true;
   }
   return {rows:[],rowCount:1};
  }};
  const store=new ReplicationStore({connect:async()=>db,query:db.query},'instance');
  store.boundary=async()=>({busy:0,sequence:'2'});store.position=async()=>null;store.unfinished=async()=>null;
  const route={primary:'node-a',replica:'node-b',epoch:1,shardId:'0'};
  const worker=new ReplicationWorker({runtime:{owns:()=>true,cache:{routeOf:()=>route},coordination:{members:new Map([['node-b',{}]])}},store,
   snapshot:async()=>({hash:'new'}),quiesce:async()=>true,release:async()=>{},log(){},
   send:async(user,r,token)=>{p.batch.token=token;p.publish([]);return {settle:()=>p.settle(committed)};}});
  if(fail)await assert.rejects(worker.sync('user'),/PG COMMIT failed/);else await worker.sync('user');
  for(const kind of ['home','workspace','blob'])assert.equal(value(kind),fail?'old':'new');
  assert.equal(queries.includes('ROLLBACK'),fail);await worker.close();
 }
});
test('内容文件发布失败也恢复两棵目录和上一版内容',t=>{
 const {p,value}=fixture(t),rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(source,target)=>{if(source.endsWith('blob-stage'))throw Error('content failed');return rename(source,target);});
 assert.throws(()=>p.publish([{kind:'blob',file:'content'}]),/content failed/);t.mock.restoreAll();
 for(const kind of ['home','workspace','blob'])assert.equal(value(kind),'old');
});
