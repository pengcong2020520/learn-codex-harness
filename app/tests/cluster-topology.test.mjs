import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { clusterNodes, clusterUpstreams } from '../server/modules/config/cluster.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { ReplicationControl, ring } from '../server/modules/replication/control.mjs';
import { attachReplication } from '../server/modules/replication/index.mjs';
import { startCoordinatedServer } from '../server/modules/coordination/node.mjs';
import { createHttpService } from '../server/modules/http/index.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { authenticateNode, nodeKeyHash } from '../server/modules/sharding/routing.mjs';
const all = ['node-a', 'node-b', 'node-c'];
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-topology-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test('topology: 默认值与严格前缀；非法取值在读取模型或连接基础服务前中文报错', t => {
  const root = temp(t);
  assert.deepEqual(clusterNodes(), ['node-a']);
  for (let n = 1; n <= 3; n++) assert.deepEqual(clusterNodes({ AGENT_CLUSTER_NODES: all.slice(0, n).join(',') }), all.slice(0, n));
  for (const value of ['', 'node-b', 'node-a,node-c', 'node-b,node-a', 'node-a,node-a', 'node-a,node-b,node-c,node-d', ' node-a', 'node-a,', 'node-a, node-b']) {
    assert.throws(() => loadServerConfig(root, { AGENT_CLUSTER_NODES: value }), /AGENT_CLUSTER_NODES 只能是/);
  }
});

test('topology: ring 1/2/3 节点；三节点保留教程最终章的原始放置', () => {
  const owners = nodes => ['0', '1', '2'].map(id => ring(id, nodes));
  assert.deepEqual(owners(all.slice(0, 1)), Array.from({ length: 3 }, () => ({ primary: 'node-a', replica: null, epoch: 1 })));
  assert.deepEqual(owners(all.slice(0, 2)), [
    { primary: 'node-a', replica: 'node-b', epoch: 1 }, { primary: 'node-b', replica: 'node-a', epoch: 1 }, { primary: 'node-a', replica: 'node-b', epoch: 1 },
  ]);
  assert.deepEqual(owners(all), [
    { primary: 'node-a', replica: 'node-b', epoch: 1 }, { primary: 'node-b', replica: 'node-c', epoch: 1 }, { primary: 'node-c', replica: 'node-a', epoch: 1 },
  ]);
});

function placement(nodes, rows = []) {
  const writes = [], published = [], members = new Map(nodes.map(nodeId => [nodeId, { nodeId }]));
  const db = { async query(sql, args) {
    if (sql.startsWith('SELECT *')) return { rows: rows.map(row => ({ ...row })) };
    if (sql.startsWith('INSERT INTO agent_data.shard_owners') && !rows.some(row => row.shard_id === args[0]))
      rows.push({ shard_id: args[0], node_id: args[1], epoch: args[2], replica: args[3], previous_primary: null, replica_ready: false, publishing: true });
    if (sql.startsWith('UPDATE agent_data.shard_owners SET replica=$2')) {
      writes.push({ sql, args });
      const row = rows.find(row => row.shard_id === args[0]);
      if (row.node_id === args[2] && !row.replica && !row.previous_primary && !row.recovering && !row.publishing)
        Object.assign(row, { replica: args[1], replica_ready: false, publishing: true });
    }
    return { rows: [] };
  } };
  const control = new ReplicationControl({ members }, {}, db, 'test-instance', nodes);
  control.locked = work => work(db);
  control.publish = async () => { published.push(structuredClone(rows)); rows.forEach(row => { row.publishing = false; }); };
  return { control, rows, members, writes, published };
}

test('topology: place 默认三个分片全在 node-a；1→3 只补在线副本、不迁主、不增加 epoch', async () => {
  const f = placement(['node-a']); await f.control.place();
  assert.equal(f.rows.length, 3);
  assert.ok(f.rows.every(row => row.node_id === 'node-a' && row.replica === null));
  f.control.nodes = all;
  await f.control.place(); assert.equal(f.writes.length, 0, '环上下一个节点尚未上线');
  f.members.set('node-c', { nodeId: 'node-c' });
  await f.control.place(); assert.equal(f.writes.length, 0, '不绕过尚未上线的 node-b');
  f.members.set('node-b', { nodeId: 'node-b' });
  await f.control.place();
  assert.equal(f.writes.length, 3);
  assert.ok(f.rows.every(row => row.node_id === 'node-a' && row.replica === 'node-b' && row.epoch === 1 && row.replica_ready === false));
  assert.ok(f.published.at(-1).every(row => row.publishing === true));
  await f.control.place(); assert.equal(f.writes.length, 3, '重复放置保持幂等');
});

test('topology: 接管后 previous_primary 不走扩容补副本；按当前主节点选择下一个节点', async () => {
  const f = placement(all, [
    { shard_id: '0', node_id: 'node-b', replica: null, previous_primary: 'node-a', epoch: 2 },
    { shard_id: '1', node_id: 'node-c', replica: null, previous_primary: null, epoch: 4 },
    { shard_id: '2', node_id: 'node-b', replica: null, previous_primary: null, epoch: 7 },
  ]);
  f.members.delete('node-a'); await f.control.place();
  assert.equal(f.rows[0].replica, null);
  assert.equal(f.rows[1].replica, null, 'node-c 的下一个是离线 node-a');
  assert.equal(f.rows[2].replica, 'node-c');
  assert.deepEqual(f.rows.map(row => row.node_id), ['node-b', 'node-c', 'node-b']);
});

for (const column of ['node_id', 'replica']) test(`topology: 启动拒绝配置缩小（${column}），关闭数据库且不注册成员/监听端口`, async () => {
  let closed = 0, connected = 0;
  const secret = 'test-only-node-key-123456789';
  const config = { clusterNodes: ['node-a'], data: {} };
  const env = { AGENT_NODE_ID: 'node-a', AGENT_NODE_KEY: secret, AGENT_NODE_KEY_A_HASH: nodeKeyHash(secret) };
  await assert.rejects(startCoordinatedServer({ config, env,
    database: async () => ({ query: async () => ({ rows: [{ node_id: 'node-a', replica: null, [column]: 'node-b' }] }), end: async () => closed++ }),
    connect: async () => { connected++; throw Error('不应连接'); },
  }), /集群节点只能增加；要移除节点先用 move\/promote 迁走分片/);
  assert.equal(closed, 1); assert.equal(connected, 0);
});

test('topology: 单节点无需 B/C 密钥；即使提供了未配置节点的有效密钥也拒绝请求', async () => {
  const key = 'test-only-node-key-123456789', hash = nodeKeyHash(key);
  const env = { AGENT_NODE_ID: 'node-a', AGENT_NODE_KEY: key, AGENT_NODE_KEY_A_HASH: hash };
  let connects = 0, closed = 0;
  await assert.rejects(startCoordinatedServer({ config: { clusterNodes: ['node-a'], data: {} }, env,
    database: async () => ({ query: async () => ({ rows: [] }), end: async () => closed++ }),
    connect: async () => { connects++; throw Error('测试连接边界'); },
  }), /测试连接边界/);
  assert.equal(connects, 1); assert.equal(closed, 1);
  assert.throws(() => authenticateNode({ 'x-node-id': 'node-b', 'x-node-key': key }, { 'node-a': hash, 'node-b': hash }, ['node-a']), { code: 'NODE_AUTH' });
  await assert.rejects(startCoordinatedServer({ config: { clusterNodes: ['node-a'] }, env: { ...env, AGENT_NODE_ID: 'node-b' } }), /必须属于 AGENT_CLUSTER_NODES/);
});

async function request(handle, url) {
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handle({ url, method: 'GET', headers: { authorization: 'test' } }, response); return response;
}
for (const nodes of [['node-a'], all]) test(`topology: ${nodes.length} 节点真实 /ready 与 /cluster；缺副本仅在单节点关闭复制`, async t => {
  const root = temp(t), rows = ['0','1','2'].map(shard_id => ({ shard_id, node_id: 'node-a', replica: null, epoch: 2, replica_ready: false, previous_primary: nodes.length > 1 ? 'node-b' : null }));
  const members = new Map([['node-a', { nodeId: 'node-a' }]]);
  const runtime = { nodes, nodeId: 'node-a', coordination: { members, status: async () => ({ members: [...members.values()] }) }, cache: { shards: {}, slots: {}, revision: '1' }, paused: new Set() };
  const app = { config: { root, generation: {}, sharding: runtime }, data: { pool: { query: async () => ({ rows: [] }) }, scope: { instanceId: 'i' }, jobs: { patch: async () => ({}) } },
    runtimes: { pool: { entries: new Map() } }, close: async () => {}, accounts: { authenticate: async () => ({ role: 'admin' }) } };
  const control = { rows: async () => rows, reasons: new Map() };
  runtime.replication = attachReplication(app, runtime, control); t.after(() => app.close());
  const http = createHttpService({ config: app.config, sessions: {}, hub: new EventEmitter(), redact: JSON.stringify, readiness: async () => ({ status: 'ready' }) });
  app.http = http;
  const ready = await request(http.handle, '/ready'); assert.equal(ready.status, 200);
  const cluster = await request(createShardedHandler(runtime.coordination, { app, isReady: () => true }, runtime, control), '/cluster');
  assert.equal(cluster.status, 200); assert.equal(cluster.body.replication, nodes.length === 1 ? 'off' : 'on');
  assert.deepEqual(Object.keys(cluster.body.routeRevisions), nodes);
  if (nodes.length === 1) {
    assert.equal(ready.body.degraded, undefined); assert.equal(ready.body.replication, 'off');
    assert.ok(cluster.body.shards.every(row => row.replica_lagging === false));
    const worker = runtime.replication.worker; worker.schedule('user'); await runtime.replication.tick();
    assert.equal(await worker.sync('user'), false); assert.equal(worker.timer, undefined); assert.equal(worker.timers.size, 0);
  } else {
    assert.deepEqual(ready.body.degraded, { replica_lagging: ['0','1','2'] });
    assert.ok(cluster.body.shards.every(row => row.replica_lagging === true));
  }
});

test('topology: Caddy 上游运行时生成与配置一致；单节点无 B/C DNS，非法值退出', t => {
  const root = temp(t); fs.writeFileSync(path.join(root, 'caddy'), '#!/bin/sh\nprintf "%s" "$AGENT_UPSTREAMS"\n', { mode: 0o755 });
  for (let n = 1; n <= 3; n++) for (const remote of [false, true]) {
    const nodes = all.slice(0, n), env = { ...process.env, PATH: `${root}:${process.env.PATH}`, AGENT_CLUSTER_NODES: nodes.join(','), NODE_B_UPSTREAM: remote ? 'example.com:4341' : '' };
    const result = spawnSync('/bin/sh', [new URL('../deploy/caddy-upstreams.sh', import.meta.url).pathname], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, clusterUpstreams(nodes, env));
    if (n === 1) assert.equal(result.stdout, 'node-a:4340');
  }
  const result = spawnSync('/bin/sh', [new URL('../deploy/caddy-upstreams.sh', import.meta.url).pathname], { env: { ...process.env, AGENT_CLUSTER_NODES: 'node-b' }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /AGENT_CLUSTER_NODES 只能是/);
});

test('topology: Compose 默认仅七服务，cluster profile 添加 B/C，密钥可空且 Caddy 无 B/C 依赖', () => {
  const compose = read('compose.yaml').split('services:\n')[1].split('\nnetworks:')[0];
  const services = [...compose.matchAll(/^  ([\w-]+):[^\n]*\n([\s\S]*?)(?=^  [\w-]+:|(?![\s\S]))/gm)];
  const active = profile => services.filter(([, , body]) => !body.includes('profiles:') || body.includes(`profiles: ["${profile}"]`)).map(([, name]) => name).sort();
  assert.deepEqual(active(), ['caddy','etcd','etcd-init','gateway','node-a','postgres','redis']);
  assert.deepEqual(active('cluster'), ['caddy','etcd','etcd-init','gateway','node-a','node-b','node-c','postgres','redis']);
  const caddy = services.find(([, name]) => name === 'caddy')[2];
  assert.doesNotMatch(caddy, /node-[bc]: \{ condition:/);
  assert.match(caddy, /AGENT_CLUSTER_NODES: \$\{AGENT_CLUSTER_NODES-node-a\}/);
  assert.doesNotMatch(compose, /\$\{(?:AGENT_NODE_(?:KEY_[BC](?:_HASH)?|[BC]_DB_PASSWORD)|ETCD_NODE_[BC]_PASSWORD):\?/);
});

test('topology: 已迁走的旧主节点即使仍在线，也不能成为未配置副本', async () => {
  for (const nodes of [['node-a'], ['node-a','node-b']]) {
    const f = placement(nodes, ['0','1','2'].map(shard_id => ({ shard_id, node_id:'node-a', replica:null, previous_primary:'node-c', epoch:2 })));
    f.members.set('node-c', {nodeId:'node-c'});
    await f.control.place();
    assert.ok(f.rows.every(row => row.replica === null));
  }
});
