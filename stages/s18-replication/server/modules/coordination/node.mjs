import { configureReplicationTimeouts } from '../replication/request-timeout.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { loadServerConfig, loadEnvironment } from '../config/index.mjs';
import { revision } from '../deployment/index.mjs';
import { AgentDefinition } from '../agents/index.mjs';
import { RUNTIME_LIMIT } from '../runtimes/pool.mjs';
import { startAgentServer } from '../../main.mjs';
import { connectEtcd } from './etcd.mjs';
import { Coordination } from './index.mjs';
import { Rejoin } from './rejoin.mjs';
import { ShardedService } from '../sharding/service.mjs';
import { RouteCache } from '../sharding/cache.mjs';
import { nodeKeyHash } from '../sharding/routing.mjs';
import { ShardRuntime } from '../sharding/runtime.mjs';
import { ReplicationControl } from '../replication/control.mjs';
import { attachReplication } from '../replication/index.mjs';
import { createShardedHandler } from '../sharding/http.mjs';
import { openDatabase, identity } from '../data/database.mjs';

export { createShardedHandler as nodeHandler } from '../sharding/http.mjs';

export async function startCoordinatedServer({ config = loadServerConfig(), env = loadEnvironment(config.root), connect = connectEtcd,
  start = options => startAgentServer(options), log = console.log } = {}) {
  const nodeId = env.AGENT_NODE_ID;
  const adapter = await connect(env.ETCD_ENDPOINT || 'http://etcd:2379', { username: env.ETCD_USERNAME || nodeId, password: env.ETCD_PASSWORD }, { prefix: env.ETCD_PREFIX });
  const agent = new AgentDefinition(config.root, config.agentFile);
  const coordination = new Coordination({ ...adapter, nodeId, address: env.AGENT_NODE_ADDRESS || `http://${nodeId}:${config.port}`,
    revision: revision(config.root), agentHash: createHash('sha256').update(fs.readFileSync(agent.file)).update(agent.instructions).digest('hex'), capacity: RUNTIME_LIMIT });
  if (!env.AGENT_NODE_KEY || env.AGENT_NODE_KEY.length < 24) throw new Error('AGENT_NODE_KEY 至少 24 位。');
  const keyHashes = Object.fromEntries(['A','B','C'].map(n => ['node-' + n.toLowerCase(), env[`AGENT_NODE_KEY_${n}_HASH`]]));
  if (Object.values(keyHashes).some(h => !/^[a-f0-9]{64}$/.test(h || '')) || keyHashes[nodeId] !== nodeKeyHash(env.AGENT_NODE_KEY)) throw new Error('节点密钥哈希缺失或不匹配。');
  const pool = await openDatabase(config.data.databaseUrl, { maintenance: false });
  const cache = await new RouteCache(adapter.client, env.AGENT_SHARD_STRATEGY || 'slots').open();
  const runtime = new ShardRuntime({ nodeId, cache, coordination, key: env.AGENT_NODE_KEY, keyHashes });
  const control = new ReplicationControl(coordination, cache, pool, identity(config.root, { create: false }).instanceId);
  control.log = log;
  const service = new ShardedService(coordination, generation => start({ config: { ...config, sharding: runtime }, generation, externalHttp: true, log }), runtime, log);
  const handler = createShardedHandler(coordination, service, runtime, control);
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.destroy()); });
  configureReplicationTimeouts(server);
  let updating = false;
  const tick = async () => {
    if (updating || !coordination.checkLease()) return;
    updating = true;
    try {
      if (coordination.isController()) { await coordination.confirm(); await control.reconcile(); await coordination.writeInfo(); }
      await cache.refresh();
      // All nodes share only the deployment identity, never a data disk. Wait for SQL placement before workers.
      const mapped = (await pool.query('SELECT count(*)::int AS n FROM agent_data.user_shards')).rows[0].n;
      if (mapped && Object.keys(cache.shards).length === 3) {
        runtime.prepared = true;
        if (!service.isReady()) await service.resume();
      }
      if (service.app && !service.app.replication) runtime.replication = attachReplication(service.app,runtime,control);
      void service.app?.replication?.tick().catch(error => log(`副本对账未完成：${error.code || error.message}`));
    } catch (error) { log(`分片放置/启动未完成：${error.code || error.message}`); }
    finally { updating = false; }
  };
  const routeChanged = () => { void tick(); };
  cache.on('change', routeChanged);
  coordination.on('members', () => { void tick(); });
  coordination.on('controller', () => { void tick(); });
  const timer = setInterval(() => { void tick(); }, 5000); timer.unref();
  const rejoin = new Rejoin(coordination, service);
  let closing;
  const close = () => closing ||= (async () => {
    clearInterval(timer); cache.off('change', routeChanged);
    await rejoin.close();
    // Finish the old generation before releasing membership; disks remain node-local.
    await service.app?.replication?.close();
    await service.stop();
    try { await cache.close(); await pool.end(); await coordination.close(); }
    finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  })();
  try {
    await coordination.join();
    await coordination.watchMembers();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    coordination.campaign();
    log(`分片节点 ${nodeId} 已启动；归属表准备并完成本分片恢复后 /ready=200。`);
    return { coordination, service, cache, control, server, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
