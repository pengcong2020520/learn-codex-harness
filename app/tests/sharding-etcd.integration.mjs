import test from 'node:test';
import { etcdTestScope } from './fixtures/etcd-test-scope.mjs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connectEtcd } from '../server/modules/coordination/etcd.mjs';
import { Coordination } from '../server/modules/coordination/index.mjs';
import { RouteCache } from '../server/modules/sharding/cache.mjs';
import { defaultSlots } from '../server/modules/sharding/strategy.mjs';
const endpoint=process.env.ETCD_TEST_ENDPOINT;
test('真实带认证 etcd：仅 elected control guardedPut；其他节点 Watch 在 1 秒内看到 shards/slots/overrides', {skip:!endpoint,timeout:30000},async t=>{
 const scope=etcdTestScope(t,'sharding',40000);
 const nodes=[]; let cache;
 for(const suffix of ['a','b']){
  const password=process.env[`ETCD_TEST_NODE_${suffix.toUpperCase()}_PASSWORD`];assert.ok(password,'must use authenticated node credentials');
  const adapter=await scope.connect(`node-${suffix}`,password);
  const c=new Coordination({...adapter,nodeId:`node-${suffix}`,address:`http://node-${suffix}:4340`});nodes.push(c);scope.defer(`node-${suffix} election/lease/watch`,()=>c.close());await c.join();await c.watchMembers();
 }
 const [a,b]=nodes;a.campaign();b.campaign();
 for(let n=0;n<100&&!nodes.some(c=>c.isController());n++)await delay(50);
 const leader=nodes.find(c=>c.isController()),follower=nodes.find(c=>!c.isController());assert.ok(leader);
 cache=new RouteCache(follower.client);scope.defer('route cache Watch',()=>cache.close());await cache.open();
 await assert.rejects(follower.guardedPut(scope.key('shards/0'),{primary:'node-b',epoch:99}),{code:'NOT_CONTROLLER'});
 const user='00000000-0000-4000-8000-000000000017';const start=performance.now();
 await leader.guardedPut(scope.key('shards/0'),{primary:leader.nodeId,epoch:1});await leader.guardedPut(scope.key('slots'),defaultSlots());await leader.guardedPut(scope.key('overrides/')+user,'"0"');
 while((cache.routeOf(user).primary!==leader.nodeId||cache.overrides[user]!=='0'||Object.keys(cache.slots).length!==64)&&performance.now()-start<1000)await delay(5);
 assert.equal(cache.routeOf(user).primary,leader.nodeId);assert.equal(cache.routeOf(user).shardId,'0');assert.ok(performance.now()-start<1000);
 // ACL is bounded to /codex; application election fencing supplies dynamic control authority.
 await assert.rejects(follower.client.put('/outside-codex').value('denied'));
 const bad=await connectEtcd(endpoint,{username:'node-a',password:'deliberately-wrong'});scope.defer('bad credentials client',()=>bad.client.close());await assert.rejects(bad.client.get(scope.key('slots')).exec());
});
