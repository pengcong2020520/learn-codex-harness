import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { loadServerConfig, loadEnvironment } from '../config/index.mjs';
import { revision } from '../deployment/index.mjs';
import { AgentDefinition } from '../agents/index.mjs';
import { RUNTIME_LIMIT } from '../runtimes/pool.mjs';
import { startAgentServer } from '../../main.mjs';
import { connectEtcd } from './etcd.mjs';
import { Coordination, TTL } from './index.mjs';
import { ActiveService, clusterStatus } from './service.mjs';

export function nodeHandler(coordination, service) {
  return async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const route = `${request.method} ${new URL(request.url, 'http://localhost').pathname}`;
      if (route === 'GET /health') return json(200, { status: 'alive' });
      if (!service.isReady()) return json(503, { status: 'not-ready', code: 'NOT_CONTROLLER' });
      // Confirm the term before accepting HTTP, even after a paused event loop resumes.
      await coordination.confirm();
      if (!service.isReady()) return json(503, { status: 'not-ready' });
      if (route === 'GET /cluster') {
        if (request.headers.origin !== undefined) return json(403, { error: 'CLI only' });
        return json(200, await clusterStatus(coordination, service.app.accounts, request.headers.authorization));
      }
      return service.app.http.handle(request, response);
    } catch (error) {
      if (!response.headersSent) json(error.code === 'NOT_CONTROLLER' ? 503 : error.status || 503, { error: { code: error.code || 'UNAVAILABLE' } });
      else response.end();
    }
  };
}

export async function startCoordinatedServer({ config = loadServerConfig(), env = loadEnvironment(config.root), connect = connectEtcd,
  start = options => startAgentServer(options), log = console.log } = {}) {
  const nodeId = env.AGENT_NODE_ID;
  const adapter = await connect(env.ETCD_ENDPOINT || 'http://etcd:2379');
  const agent = new AgentDefinition(config.root, config.agentFile);
  const coordination = new Coordination({ ...adapter, nodeId, address: `http://${nodeId}:${config.port}`,
    revision: revision(config.root), agentHash: createHash('sha256').update(fs.readFileSync(agent.file)).update(agent.instructions).digest('hex'), capacity: RUNTIME_LIMIT });
  const service = new ActiveService(coordination, generation => start({ config, generation, externalHttp: true, log }), log);
  const server = createServer((req, res) => { void nodeHandler(coordination, service)(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  let update, dirty = false;
  const info = () => {
    dirty = true;
    if (!coordination.isController() || update) return;
    update = (async () => {
      while (dirty && coordination.isController()) { dirty = false; await coordination.writeInfo(); }
    })().catch(() => coordination.isolate('info-write-failed')).finally(() => {
      update = null;
      if (dirty && coordination.isController()) info();
    });
  };
  coordination.on('members', info);
  // Also observes election changes for the recent-event ring, without user traffic.
  let observing = false;
  const timer = setInterval(() => {
    if (!observing && !coordination.closed) {
      observing = true;
      void coordination.status().catch(() => {}).finally(() => { observing = false; });
    }
  }, TTL * 1000 / 3);
  timer.unref();
  let closing;
  const close = () => closing ||= (async () => {
    clearInterval(timer);
    // Shut down the old process pool before resign allows the next control to use shared files.
    await service.stop();
    try { await coordination.close(); }
    finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  })();
  try {
    await coordination.join();
    await coordination.watchMembers();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    coordination.campaign();
    log(`协调节点 ${nodeId} 已启动；热备 /ready=503，当选并恢复完成后才就绪。`);
    return { coordination, service, server, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
