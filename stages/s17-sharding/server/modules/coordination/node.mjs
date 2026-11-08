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
import { ShardRuntime } from '../sharding/runtime.mjs';
import { ShardControl } from '../sharding/control.mjs';
import { createShardedHandler } from '../sharding/http.mjs';
import { openDatabase } from '../data/database.mjs';

export { createShardedHandler as nodeHandler } from '../sharding/http.mjs';

export async function startCoordinatedServer({ config = loadServerConfig(), env = loadEnvironment(config.root), connect = connectEtcd,
  start = options => startAgentServer(options), log = console.log } = {}) {
  const nodeId = env.AGENT_NODE_ID;
  const adapter = await connect(env.ETCD_ENDPOINT || 'http://etcd:2379', { username: env.ETCD_USERNAME || nodeId, password: env.ETCD_PASSWORD });
  const agent = new AgentDefinition(config.root, config.agentFile);
  const coordination = new Coordination({ ...adapter, nodeId, address: `http://${nodeId}:${config.port}`,
    revision: revision(config.root), agentHash: createHash('sha256').update(fs.readFileSync(agent.file)).update(agent.instructions).digest('hex'), capacity: RUNTIME_LIMIT });
  if (!env.AGENT_NODE_KEY || env.AGENT_NODE_KEY.length < 24) throw new Error('AGENT_NODE_KEY 至少 24 位。');
  const pool = await openDatabase(config.data.databaseUrl, { maintenance: false });
  const cache = await new RouteCache(adapter.client, env.AGENT_SHARD_STRATEGY || 'slots').open();
  const runtime = new ShardRuntime({ nodeId, cache, coordination, key: env.AGENT_NODE_KEY });
  const control = new ShardControl(coordination, cache, pool);
  control.log = log;
  const service = new ShardedService(coordination, generation => start({ config: { ...config, sharding: runtime }, generation, externalHttp: true, log }), runtime, log);
  const handler = createShardedHandler(coordination, service, runtime, control);
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
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
    } catch (error) { log(`分片放置/启动未完成：${error.code || error.message}`); }
    finally { updating = false; }
  };
  coordination.on('members', () => { void tick(); });
  coordination.on('controller', () => { void tick(); });
  const timer = setInterval(() => { void tick(); }, 5000); timer.unref();
  const rejoin = new Rejoin(coordination, service);
  let closing;
  const close = () => closing ||= (async () => {
    clearInterval(timer);
    await rejoin.close();
    // Finish the old generation before releasing membership; disks remain node-local.
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
