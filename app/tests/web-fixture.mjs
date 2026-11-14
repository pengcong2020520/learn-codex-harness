import { createServer, request } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { startAgentServer } from '../server/main.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { fixture, tempRoot, installToolFixture, testDataFactory, cleanup } from './helpers.mjs';
import { mock } from './mock-codex.mjs';

// Mimic Caddy's /ui mount and same-origin reverse proxy; never write an .env.
export async function webFixture(t, { workflows } = {}) {
  const root = installToolFixture(tempRoot(t));
  if (workflows) {
    const file = `${root}/agents/writing/agent.json`, definition = JSON.parse(await readFile(file, 'utf8'));
    definition.agent.workflows = workflows; await writeFile(file, JSON.stringify(definition));
  }
  let backend; const streams = new Set(), requests = [];
  const security = {
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'
  };
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url, method: req.method, origin: req.headers.origin });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.writeHead(302, { location: '/ui/' }); res.end(); return; }
    if (url.pathname.startsWith('/ui/')) {
      const relative = url.pathname.slice(4) || 'index.html';
      if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.split('/').includes('..')) { res.writeHead(404); res.end(); return; }
      try {
        const body = await readFile(new URL(`../web/${relative}`, import.meta.url));
        res.writeHead(200, { ...security, 'content-type': relative.endsWith('.html') ? 'text/html; charset=utf-8' : relative.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(body);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    const upstream = request(backend + req.url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
      if (url.pathname === '/events') { streams.add(res); res.once('close', () => streams.delete(res)); }
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => upstream.destroy()); req.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup(root, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const cli = `${root}/mock-codex.mjs`;
  await writeFile(cli, mock.replace('30*(index+1)', '150*(index+1)').replace('},150);', '},1200);'));
  const config = loadServerConfig(root, { ...fixture, AGENT_ALLOWED_ORIGINS: url }); config.port = 0;
  const dataFactory = async config => {
    const data = await testDataFactory(config);
    const list = data.repository.listConversations;
    // The legacy in-memory fixture ignores q; mirror the production repository's search.
    data.repository.listConversations = async (q = '') => (await list()).filter(row => `${row.name} ${row.id}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
    return data;
  };
  const app = await startAgentServer({ config, cli, dataFactory, log: () => {} }); backend = app.url;
  cleanup(root, () => app.close());
  return { url, app, requests, dropStreams: () => { for (const stream of streams) stream.end(); } };
}
