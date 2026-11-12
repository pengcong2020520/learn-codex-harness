import test from 'node:test';
import assert from 'node:assert/strict';
import { etcdTestScope } from './fixtures/etcd-test-scope.mjs';
import { connectEtcd } from '../server/modules/coordination/etcd.mjs';
import { Coordination } from '../server/modules/coordination/index.mjs';
const endpoint = process.env.ETCD_TEST_ENDPOINT;
test('真实 etcd：认证三成员、唯一 control、撤销同一 lease 后 ≤12s 接任、旧任期拒写', {
  skip: !endpoint && '未设置 ETCD_TEST_ENDPOINT；需要真实认证 etcd，离线测试不能替代此验收。', timeout: 40000,
}, async t => {
  const scope = etcdTestScope(t, 'coordination', 50000), { until } = scope;
  const nodes = [];
  for (const [index, nodeId] of ['node-a', 'node-b', 'node-c'].entries()) {
    const password = process.env[`ETCD_TEST_NODE_${nodeId.at(-1).toUpperCase()}_PASSWORD`];
    assert.ok(password, '需要 ETCD_TEST_NODE_A/B/C_PASSWORD，用户为 node-a/b/c');
    const adapter = await scope.connect(nodeId, password);
    await assert.rejects(adapter.client.put('/outside-codex/forbidden').value('no'), /permission denied/i);
    if (!index) {
      const anonymous = await connectEtcd(endpoint);
      try { await assert.rejects(anonymous.client.getAll().prefix('/codex/').exec(), /permission denied|authentication|user name is empty/i); }
      finally { anonymous.client.close(); }
    }
    if (!index) assert.equal((await adapter.client.getAll().prefix(scope.prefix).exec()).kvs.length, 0);
    const c = new Coordination({ ...adapter, nodeId, address: `http://${nodeId}:${4340 + index}`, revision: 'integration', agentHash: 'integration', capacity: 4 });
    scope.defer(`${nodeId} election/lease/watch`, () => c.close());
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
  await assert.rejects(old.guardedPut(scope.key('cluster/info'), 'stale'), error => error.code === 'NOT_CONTROLLER' && error.status === 409);
  // Direct etcd3 transaction proves storage fencing even if old application flags were stale.
  const stale = await old.client.if(old.electionKey, 'Create', '==', oldTerm).then(old.client.put(scope.key('cluster/info')).value('stale')).commit();
  assert.equal(stale.succeeded, false);
  await next.writeInfo();
  await until(() => nodes.filter(c => c !== old).every(c => c.members.size === 2), 12000);
  // Remove only our demonstration key; normal close resigns/revokes registrations and candidates.
  await next.client.delete().key(scope.key('cluster/info'));
});
