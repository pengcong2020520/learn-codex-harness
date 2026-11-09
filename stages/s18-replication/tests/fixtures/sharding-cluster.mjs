import { ReplicationControl } from '../../server/modules/replication/control.mjs';
import { attachReplication } from '../../server/modules/replication/index.mjs';
import { nodeAuth, authHeaders } from './node-auth.mjs';
// Shared s18 cluster boot: real node SQL roles, shard fencing and external HTTP.
import assert from 'node:assert/strict';
import { configureReplicationTimeouts } from '../../server/modules/replication/request-timeout.mjs';
import { createServer } from 'node:http';
import { startAgentServer } from '../../server/main.mjs';
import { loadServerConfig } from '../../server/modules/config/index.mjs';
import { openDatabase } from '../../server/modules/data/database.mjs';
import { ShardRuntime } from '../../server/modules/sharding/runtime.mjs';
import { ShardControl } from '../../server/modules/sharding/control.mjs';
import { createShardedHandler } from '../../server/modules/sharding/http.mjs';
import { Coordination } from '../../server/modules/coordination/index.mjs';
import { cleanup } from '../helpers.mjs';

// Exercise the production wire serializer, not an always-JSON-encoding double.
export function scriptedCoordination({ client, nodeId, members, term, isolations, controlNode = 'node-a' }) {
  const electionKey = '/codex/controller/test';
  if (!client.kvs.has(electionKey)) client.set(electionKey, 'node-a');
  const ownTerm = client.kvs.get(electionKey).create_revision;
  const c = { client, nodeId, members, ownTerm, electionKey, generation: 1,
    checkLease: () => true, isController: () => nodeId === controlNode,
    assertController: () => assert.equal(nodeId, controlNode), confirm: async () => {}, term: () => term,
    observeControl: async () => ({ nodeId: controlNode, term }),
    isolate: reason => isolations.push({ nodeId, reason }) };
  c.guardedPut = Coordination.prototype.guardedPut.bind(c);
  return c;
}

export async function startClusterNode({ root, nodeRoot, databaseUrl, redisUrl, password, provider, cache, coordination, term, logs, isolations, server, replication = false }) {
  const nodeId = coordination.nodeId, suffix = nodeId.slice(-1);
  const runtime = new ShardRuntime({ nodeId, cache, coordination, ...nodeAuth(nodeId) });
  const generation = { active: true, nodeId, routes: cache, term, assert() { assert.ok(this.active && coordination.checkLease()); },
    log: line => logs.push(line), isolate: reason => { isolations.push({ nodeId, reason }); generation.active = false; } };
  const url = new URL(databaseUrl); url.username = 'agent_node_' + suffix; url.password = password;
  url.searchParams.set('options', '-c app.maintenance=off');
  const config = loadServerConfig(nodeRoot, { DATABASE_URL: url.href, REDIS_URL: redisUrl,
    CODEX_API_KEY: 'local-fixture', CODEX_BASE_URL: provider.url, CODEX_MODEL: 'local-fixture-model',
    CODEX_MODEL_CATALOG_ENABLED: 'true', CODEX_MODEL_CONTEXT_WINDOW: '128000', DEMO_TIMEOUT_MS: '30000' });
  config.port = 0; config.sharding = runtime;
  const app = await startAgentServer({ config, generation, externalHttp: true, log: line => logs.push(line) });
  cleanup(root, () => app.close());
  const controlPool = await openDatabase(url.href, { maintenance: false }); cleanup(root, () => controlPool.end());
  const control = new (replication ? ReplicationControl : ShardControl)(coordination, cache, controlPool, app.data.scope.instanceId); control.log = line => logs.push(line);
  const handler = createShardedHandler(coordination, { app, isReady: () => generation.active }, runtime, control);
  if(replication) runtime.replication=attachReplication(app,runtime,control);
  if (!server) server = configureReplicationTimeouts(createServer());
  server.on('request', (req, res) => { void handler(req, res); });
  if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup(root, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  coordination.members.set(nodeId, { nodeId, address });
  return { app, runtime, generation, address, control, server };
}
