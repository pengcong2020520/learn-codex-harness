import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { etcdTestScope, isolatedDatabase, nodeDatabasePassword } from './fixtures/etcd-test-scope.mjs';
import { Coordination } from '../server/modules/coordination/index.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { ReplicationControl } from '../server/modules/replication/control.mjs';
import { openDatabase,migrate } from '../server/modules/data/database.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
const endpoint=process.env.ETCD_TEST_ENDPOINT,url=process.env.DATA_TEST_DATABASE_URL;
test('真实认证 etcd + PG：未追平不切换；租约过期后 15 秒内 PG/etcd 接管一致', {skip:!endpoint||!url,timeout:50000},async t=>{
 const scope=etcdTestScope(t,'replication',60000), {step,until,defer}=scope;
 const databaseUrl=await step('create isolated PG database',()=>isolatedDatabase(url,defer));
 const admin=await openDatabase(databaseUrl,{maintenance:true});defer('PG admin pool',()=>admin.end());
 await step('migrate PG',()=>migrate(admin));
 const password=nodeDatabasePassword;
 await step('provision PG roles',()=>provisionNodeRoles(admin,{a:password,b:password,c:password},(new URL(databaseUrl)).pathname.slice(1)));
 const nodes=[];
 for(const suffix of ['a','b','c']) {
  const password=process.env[`ETCD_TEST_NODE_${suffix.toUpperCase()}_PASSWORD`];assert.ok(password,'必须配置每节点认证');
  await step(`join/watch node-${suffix}`,async()=>{
   const adapter=await scope.connect('node-'+suffix,password);
   const c=new Coordination({...adapter,nodeId:'node-'+suffix,address:`http://node-${suffix}:434${nodes.length}`});
   nodes.push(c);defer(`node-${suffix} election/lease/watch`,()=>c.close());
   await c.join();await c.watchMembers();
  });
 }
 const [a,b,c]=nodes;c.campaign();
 await step('elect node-c and observe all three members',()=>until(()=>c.isController()&&c.members.size===3));
 const dburl=new URL(databaseUrl);dburl.username='agent_node_c';dburl.password=password;
 const pool=await openDatabase(dburl.href,{maintenance:false});defer('PG control pool',()=>pool.end());
 const cache=new RouteCache(c.client);defer('route cache Watch',()=>cache.close());
 await step('open route cache',()=>cache.open());
 const ctl=new ReplicationControl(c,cache,pool,randomUUID(), ['node-a','node-b','node-c']);ctl.log=line=>console.error(line);
 await step('place initial ring and publish PG/etcd',()=>ctl.place());
 let failure;
 const reconcile=()=>{void ctl.reconcile().catch(e=>{failure=e;});};
 c.on('members',reconcile);
 defer('stop and drain replication reconciliation',async()=>{c.off('members',reconcile);await ctl.pending;});
 await step('expire unready node-a lease (natural TTL)',async()=>{
  a.lease.release();await until(()=>![...c.members.values()].some(m=>m.nodeId==='node-a'));
  await ctl.reconcile();assert.equal(cache.shards['0'].primary,'node-a');assert.match(ctl.reasons.get('0'),/未追平/);
 });
 await step('rejoin node-a after disposing old generation',async()=>{
  a.checkLease();await a.leaveGeneration();await a.join();await a.watchMembers();
  await until(()=>[...c.members.values()].some(m=>m.nodeId==='node-a'));
  await ctl.pending;
  assert.deepEqual(await ctl.ready('0',1,'node-a'),{ready:true});
 });
 await step('expire ready primary and take over within 15 seconds',async()=>{
  const start=Date.now();a.lease.release();
  await until(()=>{if(failure)throw failure;return cache.shards['0']?.primary==='node-b';},15000);
  assert.ok(Date.now()-start<=15000);
  await ctl.pending; // PG publishing flag is cleared after the etcd Watch event.
  assert.equal(cache.shards['0'].epoch,2);assert.equal(cache.shards['0'].replica,null);
  const row=(await ctl.rows()).find(r=>r.shard_id==='0');
  assert.equal(row.node_id,'node-b');assert.equal(Number(row.epoch),2);assert.equal(row.replica,null);
  assert.equal(row.publishing,false);assert.equal(row.recovering,true);assert.equal(failure,undefined);
  assert.ok(b.checkLease());
 });
});
