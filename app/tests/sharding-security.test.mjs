import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { authenticateNode } from '../server/modules/sharding/routing.mjs';
import { authorizeMove } from '../server/modules/sharding/operations.mjs';
import { ShardControl } from '../server/modules/sharding/control.mjs';
import { ShardRuntime } from '../server/modules/sharding/runtime.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { attachKnowledge } from '../server/modules/sharding/knowledge.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { transferLimit, limitTransfer, assertTransferSpace, restoredMode, validateTarListing } from '../server/modules/sharding/transfer.mjs';
import { MediaService } from '../server/modules/media/index.mjs';
import { KnowledgeWorker } from '../server/modules/knowledge/worker.mjs';
import { authHeaders, nodeAuth } from './fixtures/node-auth.mjs';
const user = '00000000-0000-4000-8000-000000000017', id = '00000000-0000-4000-8000-000000000018';
const op = { id, user_id: user, from_shard: '0', to_shard: '1', source_node: 'node-a', target_node: 'node-b', control_node: 'node-c', state: 'paused' };
const poolFor = row => ({ query: async () => ({ rows: row ? [row] : [] }) });

test('per-node secrets bind identity; a peer hash is not a bearer credential', () => {
  const { keyHashes } = nodeAuth('node-b');
  assert.equal(authenticateNode(authHeaders('node-a'), keyHashes), 'node-a');
  for (const headers of [{}, { ...authHeaders('node-a'), 'x-node-id':'node-c' }, { 'x-node-id':'node-a', 'x-node-key':keyHashes['node-a'] }])
    assert.throws(() => authenticateNode(headers, keyHashes), {status:403});
});
test('six migration steps require operation, state, user, caller and receiver roles', async () => {
  for (const [step,state,caller,receiver] of [['pause','paused','node-c','node-a'],['drain','paused','node-c','node-a'],['copy','copying','node-c','node-a'],['transfer','copying','node-a','node-b'],['content','copying','node-a','node-b'],['resume','switched','node-c','node-b']]) {
    const args = { operationId:id,userId:user,caller,receiver,step }, pool = poolFor({...op,state});
    await authorizeMove(pool,args);
    for (const patch of [{operationId:undefined},{operationId:'-'.repeat(36)},{userId:id},{caller:'node-b'},{receiver:'node-c'},{target:'node-c'}])
      await assert.rejects(authorizeMove(pool,{...args,...patch}), {status:403});
    for (const bad of [null,{...op,state:'failed'},{...op,state:'resumed'}]) await assert.rejects(authorizeMove(poolFor(bad),args),{status:403});
  }
});
test('HTTP migration endpoints reject missing operations before touching disk or runtime', async () => {
  const runtime = {...nodeAuth('node-a')}, app={data:{pool:poolFor(op)}};
  const handler=createShardedHandler({}, {app,isReady:()=>true}, runtime, {});
  for (const step of ['pause','drain','copy','transfer','content','resume']) {
    const binary=['transfer','content'].includes(step);
    const req=Object.assign(Readable.from(binary?[]:[Buffer.from(JSON.stringify({userId:user,target:'node-b'}))]), {method:binary?'PUT':'POST',url:`/internal/${step}?user=${user}&kind=workspace`,headers:authHeaders('node-c')});
    const res={writeHead(status){this.status=status;},end(){}};
    await handler(req,res);assert.equal(res.status,403,step);
  }
});
test('knowledge authenticates Authorization and rejects requester and revoked tokens before Hub/disk', async () => {
  let reads=0, checks=0;
  const app={accounts:{authenticate:async token=>{if(token!=='Bearer valid')throw Object.assign(new Error(),{status:401});return {userId:user};}},knowledge:{read:async()=>++reads,search:async()=>{},pages:async()=>{},kb:async()=>{checks++;return {owner_id:user};}},resources:{readById:async()=>{}},permissionHub:{withUser:async(u,fn)=>fn()},gate:{operator:u=>u,run:async(c,fn)=>fn()}};
  const runtime={cache:{revision:'1',routeOf:()=>({primary:'node-a'})},nodeId:'node-a',admit:async()=>{}};attachKnowledge(app,runtime);
  const body={action:'read',args:{kbId:'k'},revision:'1'};
  await assert.rejects(runtime.readKnowledge({...body,requester:user},'Bearer valid'),{status:403});
  for(const token of [undefined,'Bearer revoked'])await assert.rejects(runtime.readKnowledge(body,token),{status:401});
  assert.equal(reads,0);assert.equal(checks,0);
  await runtime.readKnowledge(body,'Bearer valid');assert.equal(reads,1);assert.equal(checks,1);
});
test('transfer limit cannot exceed 1 GiB; receiver aborts before writing excess bytes; 507 before writes',async()=>{
  assert.equal(transferLimit({}),1024**3);assert.equal(transferLimit({AGENT_TRANSFER_MAX_BYTES:'4'}),4);
  for(const n of ['0','-1','NaN','1.5',String(1024**3+1)])assert.throws(()=>transferLimit({AGENT_TRANSFER_MAX_BYTES:n}));
  let bytes=0;const input=Readable.from([Buffer.alloc(4),Buffer.alloc(1)]);
  await assert.rejects(pipeline(input,limitTransfer(4),new Writable({write(chunk,enc,cb){bytes+=chunk.length;cb();}})),{status:413});
  assert.equal(bytes,4);assert.equal(input.destroyed,true);
  assert.throws(()=>assertTransferSpace(os.tmpdir(),4,()=>({bavail:7n,bsize:1n})),{status:507});
  assert.doesNotThrow(()=>assertTransferSpace(os.tmpdir(),4,()=>({bavail:8n,bsize:1n})));
});
test('tar rejects setuid; restore strips special file bits and keeps directory setgid only',()=>{
  for(const mode of ['-rwsrwxrwx','-rwSrwxrwx','drwsrwxrwx'])assert.throws(()=>validateTarListing(`${mode} 0/1000 0 2026-01-01 00:00 ./file\n`,10017,'workspace'));
  assert.equal(restoredMode(0o7777,false),0o777);assert.equal(restoredMode(0o7777,true),0o2777);assert.equal(restoredMode(0o2770,true),0o2770);
});
function controlFixture({ failCommit=false, failPublish=false }={}) {
  const steps=[], row={...op,state:'copied'}, mapping={shard_id:'0',paused:true};let commits=0;
  const db={release(){},async query(sql,args){
    steps.push(sql);
    if(sql.includes("set_config('app.term',$1,true),agent_data.locked_cluster_term()"))assert.deepEqual(args,['1']);
    if(sql==='COMMIT' && ++commits===1 && failCommit)throw new Error('commit unavailable');
    if(sql.startsWith('UPDATE agent_data.move_operations SET state=$3')){row.state=args[2];return {rows:[row]};}
    if(sql.includes("SET state='failed'")){row.state='failed';return {rows:[row]};}
    if(sql.startsWith('UPDATE agent_data.user_shards SET shard_id')){mapping.shard_id=args[1];return {rows:[{user_id:user}]};}
    return {rows:[]};
  }};
  const c={nodeId:'node-c',assertController(){},confirm:async()=>{},term:()=> '1',guardedPut:async()=>{steps.push('publish');if(failPublish){c.confirm=async()=>{throw new Error('etcd unavailable');};c.term=()=>null;throw new Error('etcd unavailable');}}};
  const ctl=new ShardControl(c,{refresh:async()=>steps.push('refresh')},{connect:async()=>db});ctl.log=line=>steps.push(line);
  return {ctl,steps,row,mapping};
}
test('COMMIT precedes etcd; commit/publish failures mark failed and stay paused without rollback',async()=>{
  const f=controlFixture();await f.ctl.switchUser(user,'1',id);assert.ok(f.steps.indexOf('COMMIT')<f.steps.indexOf('publish'));assert.equal(f.row.state,'switched');
  for(const options of [{failCommit:true},{failPublish:true}]){
    const f=controlFixture(options);await assert.rejects(f.ctl.switchUser(user,'1',id));assert.equal(f.row.state,'failed');assert.equal(f.mapping.paused,true);
    assert.ok(f.steps.some(x=>x.includes('用户保持暂停')));if(options.failCommit)assert.ok(!f.steps.includes('publish'));else assert.equal(f.mapping.shard_id,'1');
  }
});
test('advanceMove always opens the control term transaction, even with an extra raw client argument', async () => {
  const f = controlFixture();
  await f.ctl.advanceMove(id, 'paused', 'copying', { query: () => assert.fail('unfenced client used') });
  assert.equal(f.row.state, 'copying');
  assert.deepEqual(f.steps.slice(0, 4), ['BEGIN', 'SELECT agent_data.advance_cluster_term($1::bigint)',
    "SELECT set_config('app.term',$1,true)", 'SELECT agent_data.locked_cluster_term()']);
  assert.equal(f.steps.at(-1), 'COMMIT');
});
test('knowledge assembly rejects a missing authenticator before installing the RPC', () => {
  const runtime = {};
  assert.throws(() => attachKnowledge({ knowledge: {} }, runtime), /缺少账号认证服务/);
  assert.equal(runtime.readKnowledge, undefined);
});
test('place refuses orphan/pre-copy/failed overrides; only switched/resumed can reconcile',async()=>{
  for(const state of [null,'paused','copying','copied','failed','switched','resumed']){
    const updates=[],logs=[],cache={refresh:async()=>{},slots:{0:'0'},shards:Object.fromEntries(['0','1','2'].map((x,i)=>[x,{primary:'node-'+['a','b','c'][i],epoch:1}])),overrides:{[user]:'1'}};
    const ctl=new ShardControl({members:new Map()},cache,{});ctl.log=x=>logs.push(x);
    ctl.locked=fn=>fn({query:async(sql,args)=>{if(sql.startsWith('SELECT * FROM agent_data.move_operations'))return {rows:state?[{...op,state}]:[]};if(sql.startsWith('UPDATE agent_data.user_shards'))updates.push(args);return {rows:[]};}});
    await ctl.place();assert.equal(updates.length,['switched','resumed'].includes(state)?1:0);assert.equal(logs.length,updates.length?0:1);
  }
});
test('old primary admission fails in PG-first and etcd-first switch windows',async()=>{
  for(const [pg,route] of [[{shard_id:'1',paused:false},{shardId:'0',primary:'node-a'}],[{shard_id:'0',paused:true},{shardId:'1',primary:'node-b'}]]){
    const runtime=new ShardRuntime({nodeId:'node-a',cache:{routeOf:()=>route},coordination:{checkLease:()=>true}});runtime.pool=poolFor(pg);
    assert.equal(await runtime.canDispatch(user),false);await assert.rejects(runtime.admit(user),{status:503});
  }
});
test('media canDispatch stops paused polls; drain waits for a poll already running',async()=>{
  let release,entered;const started=new Promise(r=>entered=r), gate=new Promise(r=>release=r);let allowed=true,calls=0;
  const media=new MediaService({store:{pending:async()=>[{ownerId:user}]}});media.sharding={canDispatch:async()=>allowed};media.poll=async()=>{calls++;entered();await gate;};
  const tick=media.tick();await started;allowed=false;let drained=false;const wait=media.waitOwner(user).then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);release();await wait;await tick;await media.tick();assert.equal(calls,1);
});
test('knowledge recovery never alters paused rows even if enumeration raced pause',async()=>{
  const sql=[],client={release(){},query:async q=>{sql.push(q);return {rows:[{paused:true}]};}};
  const worker=new KnowledgeWorker({pool:{connect:async()=>client},sharding:{canDispatch:async()=>true},query:()=>assert.fail('paused write'),rag:{discard:()=>assert.fail('paused disk delete')}},{});
  await runOwner(user,()=>worker.recoverOwner());assert.ok(sql.some(q=>q.includes('FOR SHARE')));assert.equal(sql.at(-1),'COMMIT');
});

test('content receiver deletes partial bytes on 413 and rejects 507 before writing', async t => {
  const fs=(await import('node:fs')).default, path=(await import('node:path')).default;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-content-limit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const oldLimit=process.env.AGENT_TRANSFER_MAX_BYTES;process.env.AGENT_TRANSFER_MAX_BYTES='4';
  t.after(()=>{if(oldLimit===undefined)delete process.env.AGENT_TRANSFER_MAX_BYTES;else process.env.AGENT_TRANSFER_MAX_BYTES=oldLimit;});
  const file='a'.repeat(64)+'.txt', directory=path.join(root,'.data/files/objects');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,file),'original');
  const pool={query:async sql=>({rows:sql.includes('move_operations')?[{...op,state:'copying'}]:sql.includes('SELECT paused')?[{paused:true}]:[{file,kind:'blob',digest:'a'.repeat(64)}]})};
  const handler=createShardedHandler({}, {isReady:()=>true,app:{config:{root,generation:{assert(){},log(){}}},data:{pool,scope:{instanceId:'i'}}}}, {...nodeAuth('node-b')},{});
  const receive=async chunks=>{
    const req=Object.assign(Readable.from(chunks),{url:`/internal/content?operationId=${id}&user=${user}&kind=blob&file=${file}`,method:'PUT',headers:authHeaders('node-a')});
    const res={writeHead(status){this.status=status;},end(){}};await handler(req,res);return res.status;
  };
  assert.equal(await receive([Buffer.alloc(4),Buffer.alloc(1)]),413);
  assert.deepEqual(fs.readdirSync(directory),[file]);assert.equal(fs.readFileSync(path.join(directory,file),'utf8'),'original');
  t.mock.method(fs,'statfsSync',()=>({bavail:0n,bsize:4096n}));
  assert.equal(await receive([Buffer.alloc(1)]),507);assert.deepEqual(fs.readdirSync(directory),[file]);
});

test('background knowledge forwards only the cached authenticated end-user token and owner rechecks it',async()=>{
  let valid=true,reads=0;
  const cache={revision:'1',routeOf:()=>({primary:'node-b',revision:'1'})}, coordination={members:new Map([['node-b',{nodeId:'node-b',address:'http://node-b'}]])};
  const a=new ShardRuntime({nodeId:'node-a',cache,coordination});a.rememberAuthorization({userId:user},'Bearer terminal-user');
  const b={nodeId:'node-b',cache,coordination,admit:async()=>{}};
  const app=()=>({accounts:{authenticate:async token=>{assert.equal(token,'Bearer terminal-user');if(!valid)throw Object.assign(new Error('revoked'),{status:401});return {userId:user};}},knowledge:{kb:async()=>({owner_id:id}),read:async()=>++reads,search:async()=>{},pages:async()=>{}},resources:{readById:async()=>{}},permissionHub:{withUser:async(u,fn)=>fn()},gate:{operator:u=>u,run:async(c,fn)=>fn()}});
  const source=app(),owner=app();attachKnowledge(source,a);attachKnowledge(owner,b);
  a.call=async(address,route,body,token)=>{assert.equal(body.requester,undefined);return b.readKnowledge(body,token);};
  await runOwner(user,()=>source.knowledge.read({kbId:'k'}));valid=false;
  await assert.rejects(runOwner(user,()=>source.knowledge.read({kbId:'k'})),{status:401});assert.equal(reads,1);
  assert.equal(a.authorizationFor(id),undefined);assert.doesNotMatch(JSON.stringify(a),/Bearer terminal-user/);
});
test('HTTP drain cannot respond until the media owner poll has stopped',async()=>{
  let entered,release;const started=new Promise(r=>entered=r), stopped=new Promise(r=>release=r);
  const runtime={...nodeAuth('node-a'),owns:()=>true,paused:new Set([user])};
  const app={media:{waitOwner:async owner=>{assert.equal(owner,user);entered();await stopped;}},usage:{},runtimes:{pool:{entries:new Map()}},data:{scope:{instanceId:'i'},pool:{query:async sql=>({rows:sql.includes('move_operations')?[op]:sql.includes('SELECT paused')?[{paused:true}]:[{busy:true}]})}}};
  const handler=createShardedHandler({}, {app,isReady:()=>true},runtime,{});
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({userId:user,operationId:id}))]),{method:'POST',url:'/internal/drain',headers:authHeaders('node-c')});
  const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  const request=handler(req,res);await started;assert.equal(res.status,undefined);release();await request;assert.equal(res.status,200);assert.deepEqual(res.body,{drained:false});
});
test('init-env generates distinct node secrets and hashes; Compose exposes only each node own secret',async t=>{
  const fs=(await import('node:fs')).default,path=(await import('node:path')).default;
  const {spawnSync}=await import('node:child_process'),{parseEnv}=await import('node:util'),{createHash}=await import('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-node-secrets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'server/modules/config'),{recursive:true});fs.copyFileSync(new URL('../server/modules/config/cluster.mjs',import.meta.url),path.join(root,'server/modules/config/cluster.mjs'));
  fs.mkdirSync(path.join(root,'scripts'));fs.copyFileSync(new URL('../scripts/deploy-env.mjs',import.meta.url),path.join(root,'scripts/deploy-env.mjs'));
  fs.copyFileSync(new URL('../scripts/quickstart-lib.mjs',import.meta.url),path.join(root,'scripts/quickstart-lib.mjs'));
  fs.mkdirSync(path.join(root,'shared')); fs.copyFileSync(new URL('../shared/paths.mjs',import.meta.url),path.join(root,'shared/paths.mjs'));
  fs.copyFileSync(new URL('../.env.example',import.meta.url),path.join(root,'.env.example'));fs.writeFileSync(path.join(root,'.env'),'AGENT_CLUSTER_NODES=node-a,node-b,node-c\n');
  const result=spawnSync(process.execPath,[path.join(root,'scripts/deploy-env.mjs'),'/srv/app'],{encoding:'utf8'});assert.equal(result.status,0);
  const values=parseEnv(result.stdout),keys=['A','B','C'].map(n=>values[`AGENT_NODE_KEY_${n}`]);assert.equal(new Set(keys).size,3);
  for(const n of ['A','B','C'])assert.equal(values[`AGENT_NODE_KEY_${n}_HASH`],createHash('sha256').update(values[`AGENT_NODE_KEY_${n}`]).digest('hex'));
  const compose=fs.readFileSync(new URL('../compose.yaml',import.meta.url),'utf8');
  const refs=[...compose.matchAll(/AGENT_NODE_KEY: \$\{AGENT_NODE_KEY_([ABC]):/g)].map(m=>m[1]);assert.deepEqual(refs,['A','B','C']);
  assert.equal(values.AGENT_NODE_KEY,undefined);
});
