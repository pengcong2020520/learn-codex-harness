import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connectEtcd } from '../server/modules/coordination/etcd.mjs';
import { Coordination } from '../server/modules/coordination/index.mjs';
const endpoint = process.env.ETCD_TEST_ENDPOINT;
async function until(predicate, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  assert.fail(`condition not met within ${milliseconds} ms`);
}
test('真实 etcd：三成员、唯一 control、撤销同一 lease 后 ≤12s 接任、旧任期拒写', {
  skip: !endpoint && '未设置 ETCD_TEST_ENDPOINT；需要独立、空的真实 etcd，离线测试不能替代此验收。', timeout: 40000,
}, async t => {
  const nodes = [];
  t.after(async () => { await Promise.allSettled(nodes.map(c => c.close())); });
  for (const [index, nodeId] of ['node-a', 'node-b', 'node-c'].entries()) {
    const adapter = await connectEtcd(endpoint);
    // Never delete someone else's cluster. This acceptance requires a dedicated etcd.
    if (!index) assert.equal((await adapter.client.getAll().prefix('/codex/').exec()).kvs.length, 0, '请使用空的独立测试 etcd');
    const c = new Coordination({ ...adapter, nodeId, address: `http://${nodeId}:${4340 + index}`, revision: 'integration', agentHash: 'integration', capacity: 4 });
    nodes.push(c); await c.join(); await c.watchMembers(); c.campaign();
  }
  await until(() => nodes.every(c => c.members.size === 3) && nodes.filter(c => c.isController()).length === 1, 12000);
  const old = nodes.find(c => c.isController());
  const oldTerm = old.term();
  await old.writeInfo();
  assert.equal((await old.status()).members.length, 3);
  const electionKv = (await old.client.get(old.electionKey).exec()).kvs[0];
  assert.equal(electionKv.lease, await old.lease.grant(), '成员与选举键必须绑定同一个 lease');
  const before = Date.now(); await old.lease.revoke();
  await until(() => nodes.filter(c => c !== old && c.isController()).length === 1, 12000);
  assert.ok(Date.now() - before <= 12000);
  const next = nodes.find(c => c !== old && c.isController());
  assert.ok(BigInt(next.term()) > BigInt(oldTerm));
  await assert.rejects(old.guardedPut('/codex/cluster/info', 'stale'), error => error.code === 'NOT_CONTROLLER' && error.status === 409);
  // Direct etcd3 transaction proves storage fencing even if old application flags were stale.
  const stale = await old.client.if(old.electionKey, 'Create', '==', oldTerm).then(old.client.put('/codex/cluster/info').value('stale')).commit();
  assert.equal(stale.succeeded, false);
  await next.writeInfo();
  await until(() => nodes.filter(c => c !== old).every(c => c.members.size === 2), 12000);
  // Remove only our demonstration key; normal close resigns/revokes registrations and candidates.
  await next.client.delete().key('/codex/cluster/info');
});
