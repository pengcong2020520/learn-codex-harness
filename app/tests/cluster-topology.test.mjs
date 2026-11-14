import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { clusterNodes, clusterUpstreams, validateClusterSecrets } from '../server/modules/config/cluster.mjs';
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

function replicationApp(t, control, nodes = all) {
  const runtime = { nodes, nodeId: 'node-a', paused: new Set(), cache: { shards: {}, slots: {}, revision: '1' },
    coordination: { members: control.coordination.members, isController: () => true, status: async () => ({ members: [] }) } };
  const app = { config: { root: temp(t), generation: {}, sharding: runtime },
    data: { pool: { query: async () => ({ rows: [] }) }, scope: { instanceId: 'test' }, jobs: { patch: async () => ({}) } },
    runtimes: { pool: { entries: new Map() } }, sessions: { invalidateOwner() {} },
    accounts: { authenticate: async () => ({ role: 'admin' }) }, close: async () => {} };
  runtime.replication = attachReplication(app, runtime, control);
  app.http = createHttpService({ config: app.config, sessions: {}, hub: new EventEmitter(), redact: JSON.stringify, readiness: async () => ({ status: 'ready' }) });
  t.after(() => app.close());
  return { app, runtime, api: runtime.replication };
}

test('topology: 首次放置等待全部成员；原因进入 status、/cluster、/ready；上线后恢复 s18 环形放置', async t => {
  const f = placement(all); f.members.delete('node-b'); f.members.delete('node-c');
  await f.control.place();
  assert.equal(f.rows.length, 0); assert.equal(f.published.length, 0);
  const reason = '等待配置的节点全部加入后再首次放置分片：缺 node-b、node-c';
  assert.equal(f.control.reasons.get('waiting'), reason);
  const { app, runtime, api } = replicationApp(t, f.control);
  assert.equal((await api.status()).waiting, reason);
  for (const started of [false, true]) {
    const handler = createShardedHandler(runtime.coordination, { app: started ? app : null, isReady: () => started }, runtime, f.control);
    const ready = await request(handler, '/ready');
    assert.equal(ready.status, 503); assert.equal(ready.body.waiting, reason);
    const cluster = await request(handler, '/cluster');
    assert.equal(cluster.status, started ? 200 : 503); assert.equal(cluster.body.waiting, reason);
  }
  // etcd membership keys need not equal node IDs.
  for (const nodeId of ['node-b','node-c']) f.members.set(`/members/${nodeId}`, { nodeId });
  await f.control.place();
  assert.deepEqual(f.rows.map(row => ({ primary: row.node_id, replica: row.replica, epoch: row.epoch })), ['0','1','2'].map(id => ring(id, all)));
  assert.ok(f.published.length > 0); assert.equal(f.control.reasons.has('waiting'), false);
  assert.equal((await api.status()).waiting, null);
  assert.equal((await request(app.http.handle, '/ready')).status, 200);
  f.control.rows = async () => { throw Error('database closed'); };
  const stopped = createShardedHandler(runtime.coordination, { app: null, isReady: () => false }, runtime, f.control);
  assert.equal((await request(stopped, '/ready')).status, 503, '数据库不可用时仍保持未就绪状态');
});

test('topology: 部分分片缺归属也等待全部成员：不插入新行，已有行照常对账', async () => {
  const f = placement(all, [{ shard_id: '0', node_id: 'node-a', replica: null, epoch: 3 }]);
  f.members.delete('node-c');
  await f.control.place();
  assert.deepEqual(f.rows.map(row => row.shard_id), ['0']);
  assert.equal(f.rows[0].node_id, 'node-a'); assert.equal(f.rows[0].epoch, 3);
  assert.match(f.control.reasons.get('waiting'), /缺 node-c$/);
});

test('topology: 单节点 tick 完成接管恢复并清暂停，复制 schedule、sync、open 仍关闭', async t => {
  const f = placement(['node-a'], [{ shard_id: '0', node_id: 'node-a', replica: null, epoch: 2, recovering: true }]);
  const { app, runtime, api } = replicationApp(t, f.control, ['node-a']);
  const calls = []; runtime.paused.add('test-user');
  api.store.users = async () => ['test-user'];
  api.store.recover = async (...args) => { assert.equal(runtime.paused.has('test-user'), true); calls.push(['recover', ...args]); };
  app.sessions.invalidateOwner = id => calls.push(['invalidate', id]);
  f.control.recovered = async (...args) => { calls.push(['recovered', ...args]); f.rows[0].recovering = false; };
  api.worker.store.route = async () => { throw Error('单节点不得发起复制'); };
  api.worker.schedule('test-user'); api.worker.open();
  await api.tick();
  assert.deepEqual(calls, [['recover','test-user',2,{ missingHome: true }], ['invalidate','test-user'], ['recovered','0',2,'node-a']]);
  assert.equal(runtime.paused.has('test-user'), false);
  assert.equal(await api.worker.sync('test-user'), false);
  assert.equal(api.worker.timer, undefined); assert.equal(api.worker.timers.size, 0);
});

function secrets(nodes = all) {
  const env = { AGENT_CLUSTER_NODES: nodes.join(',') };
  for (const id of nodes) {
    const suffix = id.slice(-1).toUpperCase(), key = `fixture-node-${suffix}-key-1234567890123456`;
    Object.assign(env, { [`AGENT_NODE_KEY_${suffix}`]: key, [`AGENT_NODE_KEY_${suffix}_HASH`]: nodeKeyHash(key),
      [`ETCD_NODE_${suffix}_PASSWORD`]: `fixture-etcd-${suffix}`, [`AGENT_NODE_${suffix}_DB_PASSWORD`]: `fixture_db-${suffix}` });
  }
  for (const name of ['ETCD_ROOT_PASSWORD','ETCD_HEALTH_PASSWORD','AGENT_DB_PASSWORD','REDIS_PASSWORD','AGENT_GATEWAY_KEY','AGENT_PREVIEW_SECRET']) env[name] = `fixture-${name}`;
  return env;
}

test('topology: 凭据校验只要求配置节点，单节点不要求 B/C', () => {
  for (let n = 1; n <= 3; n++) assert.doesNotThrow(() => validateClusterSecrets(secrets(all.slice(0,n)), all.slice(0,n)));
});

for (const [label, name, value] of [
  ['缺 B 密钥','AGENT_NODE_KEY_B',undefined], ['密钥太短','AGENT_NODE_KEY_B','short-fixture'],
  ['哈希不匹配','AGENT_NODE_KEY_B_HASH','b'.repeat(64)], ['哈希必须小写','AGENT_NODE_KEY_B_HASH','A'.repeat(64)],
  ['数据库口令非法','AGENT_NODE_B_DB_PASSWORD','fixture-bad-password!'],
  ...['ETCD_NODE_B_PASSWORD','AGENT_NODE_B_DB_PASSWORD','ETCD_ROOT_PASSWORD','ETCD_HEALTH_PASSWORD','AGENT_DB_PASSWORD','REDIS_PASSWORD','AGENT_GATEWAY_KEY','AGENT_PREVIEW_SECRET'].map(name => ['口令为空',name,'']),
]) test(`topology: 凭据校验 ${label} ${name}，错误只列变量名不含值`, () => {
  const env = { ...secrets(), [name]: value };
  assert.throws(() => validateClusterSecrets(env, all), error => {
    const variables = error.message.replace('集群配置检查失败，请检查变量：', '').split('、');
    assert.ok(variables.includes(name));
    assert.ok(variables.every(variable => /^[A-Z_]+$/.test(variable)));
    for (const secret of Object.values(env).filter(Boolean)) assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('topology: cluster-config check 从 dotenv 读取，成功与失败退出码且不泄漏凭据', t => {
  const root = temp(t), env = secrets(['node-a']);
  const runEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENT_|ETCD_|REDIS_PASSWORD)/.test(name)));
  const run = () => spawnSync(process.execPath, [new URL('../scripts/cluster-config.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: runEnv, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, '.env'), Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n'));
  const good = run(); assert.equal(good.status, 0, good.stderr); assert.equal(good.stdout.trim(), '集群配置检查通过：node-a');
  fs.appendFileSync(path.join(root, '.env'), '\nAGENT_CLUSTER_NODES=node-a,node-b\n');
  const bad = run(); assert.equal(bad.status, 1); assert.match(bad.stderr, /AGENT_NODE_KEY_B/); assert.equal(bad.stdout, '');
  for (const value of Object.values(env)) assert.equal(bad.stderr.includes(value), false);
});

test('topology: configure 在凭据检查失败时立即停止，检查容器只读挂载且无网络', t => {
  const root = temp(t); fs.mkdirSync(path.join(root, 'deploy')); fs.mkdirSync(path.join(root, 'bin'));
  for (const file of ['configure.sh','topology.sh']) fs.copyFileSync(new URL(`../deploy/${file}`, import.meta.url), path.join(root, 'deploy', file));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM test-image\n');
  fs.writeFileSync(path.join(root, 'bin/docker'), `#!/bin/bash
echo "$*" >> "$CALLS"
case "$*" in
 *'ensure-preview-secret.mjs') exit 0;;
 *'cluster-config.mjs nodes') echo 'node-a node-b';;
 *'cluster-config.mjs check') echo '集群配置检查失败，请检查变量：AGENT_NODE_KEY_B' >&2; exit 1;;
 *) exit 99;;
esac
`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', [path.join(root,'deploy/configure.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CALLS: path.join(root,'calls') } });
  assert.equal(result.status, 1); assert.match(result.stderr, /AGENT_NODE_KEY_B/);
  const calls = fs.readFileSync(path.join(root,'calls'),'utf8').trim().split('\n');
  assert.equal(calls.length, 3); assert.match(calls[0], /--network none --user 0 .*ensure-preview-secret.mjs$/); assert.match(calls[2], /--network none .*:ro .*cluster-config.mjs check$/);
  assert.equal(fs.existsSync(path.join(root,'.data')), false);
});

for (const nodeId of ['node-b','node-c']) test(`topology: 远端 ${nodeId} extra_hosts 只映射其他已配置节点`, () => {
  for (const nodes of [all.slice(0,all.indexOf(nodeId)+1), all]) {
    const result = spawnSync('/bin/bash', [new URL('../deploy/remote-node.sh', import.meta.url).pathname, '--compose-override'],
      { encoding: 'utf8', env: { ...process.env, NODE_ID: nodeId, AGENT_CLUSTER_NODES: nodes.join(',') } });
    assert.equal(result.status, 0, result.stderr);
    const hosts = [...result.stdout.matchAll(/^      (node-[abc]): 127\.0\.0\.1$/gm)].map(match => match[1]);
    assert.deepEqual(hosts, nodes.filter(id => id !== nodeId));
  }
  assert.doesNotMatch(read('deploy/remote.compose.yaml'), /node-[abc]:127\.0\.0\.1/);
  const script = read('deploy/remote-node.sh');
  assert.match(script, /print_compose_override > deploy\/remote.hosts.override.yaml/);
  for (const command of ['up -d --wait','stop','build']) assert.ok(script.includes(`-f deploy/remote.hosts.override.yaml ${command}`));
});

test('topology: remote tunnel 按数据读取本机 AGENT_PORT，缺省 4317 且拒绝命令注入', t => {
  const root = temp(t); fs.mkdirSync(path.join(root,'deploy')); fs.mkdirSync(path.join(root,'bin'));
  fs.copyFileSync(new URL('../deploy/remote.sh',import.meta.url), path.join(root,'deploy/remote.sh'));
  fs.writeFileSync(path.join(root,'bin/ssh'), '#!/bin/bash\necho "$*" >> "$CALLS"\nif [[ "$*" == *"compose port caddy 80"* ]]; then echo 127.0.0.1:9876; fi\n', { mode: 0o755 });
  for (const [dotenv, expected] of [[null,'4317'], ['AGENT_PORT="5123" # comment\nUNUSED=$(touch injected)\n','5123'], ['AGENT_PORT=$(touch injected)\n',null]]) {
    const file = path.join(root,'.env'); if (dotenv === null) fs.rmSync(file,{force:true}); else fs.writeFileSync(file,dotenv);
    fs.writeFileSync(path.join(root,'calls'),'');
    const result = spawnSync('/bin/bash',[path.join(root,'deploy/remote.sh'),'tunnel'], { cwd: root, encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '1', PATH: `${root}/bin:${process.env.PATH}`, CALLS: path.join(root,'calls'), DEPLOY_HOST: 'fixture-host', APP_DIR: '/opt/test-agent' } });
    const calls = fs.readFileSync(path.join(root,'calls'),'utf8');
    if (expected) { assert.equal(result.status,0,result.stderr); assert.ok(calls.includes(`-L ${expected}:127.0.0.1:9876 fixture-host`)); assert.ok(result.stdout.includes(`http://127.0.0.1:${expected}`)); }
    else { assert.equal(result.status,1); assert.match(result.stderr,/AGENT_PORT/); assert.equal(calls,''); }
    assert.equal(fs.existsSync(path.join(root,'injected')),false);
  }
});
