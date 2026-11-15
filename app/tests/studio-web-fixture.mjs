import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { studioRig } from './studio-fixture.mjs';
import { accountFixture, httpFixture, OWNER_A } from './accounts-fixture.mjs';
import { runIdentity } from '../server/modules/accounts/context.mjs';

// 浏览器使用 K3b-1 的假 Codex；所有 API、草稿、附件、feedback 分流和签名预览都由真实 HTTP 服务处理。
export async function studioWebFixture(t, { vision = true } = {}) {
  const admin = work => runIdentity({ userId: OWNER_A, role: 'admin' }, work);
  const rig = await admin(() => studioRig(t, { initialDrafts: false, vision }));
  // 真实使用几十分钟的流程被压缩到十几秒，约 140 个请求会超过默认 120 次/分钟；只放宽浏览器夹具。
  rig.config.deployment = { ...rig.config.deployment, rateLimit: 1000 };
  const { accounts, store: users } = await accountFixture(); rig.store.users = users.users;
  const requests = [], responses = [], streams = new Set();
  let http, pendingState;
  const server = createServer(async (req, res) => {
    const record = { path: req.url, method: req.method }; requests.push(record);
    if (req.method === 'POST' && ['/tasks/cancel', '/tasks/retry'].includes(req.url)) {
      const iterate = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = async function* () {
        const chunks = [];
        for await (const chunk of iterate()) { chunks.push(chunk); yield chunk; }
        record.body = JSON.parse(Buffer.concat(chunks).toString());
      };
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/state' && pendingState) {
      const { captured, released } = pendingState;
      pendingState = null;
      const end = res.end.bind(res);
      res.end = (...args) => {
        captured.resolve();
        released.promise.then(() => end(...args));
        return res;
      };
    }
    if (pathname.startsWith('/ui/')) {
      const relative = pathname.slice(4) || 'index.html';
      if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.split('/').includes('..')) { res.writeHead(404).end(); return; }
      try {
        const body = fs.readFileSync(new URL(`../web/${relative}`, import.meta.url));
        res.writeHead(200, { 'content-type': relative.endsWith('.html') ? 'text/html' : relative.endsWith('.css') ? 'text/css' : 'text/javascript',
          'content-security-policy': "default-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(body);
      } catch { res.writeHead(404).end(); }
      return;
    }
    if (pathname === '/events') { streams.add(res); res.once('close', () => streams.delete(res)); }
    if (['/tasks/feedback', '/tasks/retry', '/tasks/cancel'].includes(pathname)) {
      const end = res.end.bind(res); res.end = (body, ...args) => { if (body) responses.push({ path: pathname, status: res.statusCode, body: JSON.parse(body) }); return end(body, ...args); };
    }
    await http.handle(req, res);
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const url = `http://127.0.0.1:${server.address().port}`;
  rig.config.previewSecret = randomBytes(32).toString('hex'); rig.config.allowedOrigins = [url];
  http = httpFixture(accounts, { config: rig.config, uiAgent: rig.agent, sessions: rig.sessions, messages: rig.messages,
    files: rig.files, gate: rig.gate, permissionHub: rig.permissionHub, hub: rig.hub,
    tools: { snapshot: () => ({ tools: rig.agent.definition.agent.tools.allow.map(name => ({ name })) }) } });
  t.after(async () => { for (const stream of streams) stream.end(); await http.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const produce = (files, step, status = 'waiting', overrides = {}) => admin(() => rig.permissionHub.withUser(OWNER_A, () => rig.produce(files, step, status, overrides)));
  const login = async (username = 'alice') => (await accounts.login({ username, password: 'fixture-password' }, 'fixture')).token;
  const allFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? allFiles(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]);
  return { ...rig, url, requests, responses, produce, login, users,
    holdNextState() {
      // 服务端已经生成状态快照，只延迟响应到达浏览器，让真实事件流继续推进。
      const captured = Promise.withResolvers(), released = Promise.withResolvers();
      pendingState = { captured, released };
      return { captured: captured.promise, release: released.resolve };
    },
    packageFiles: () => allFiles(path.join(import.meta.dirname, 'fixtures/studio/package-v1')).map(file => `package-v1/${file}`),
    dropStreams: () => { for (const stream of streams) stream.end(); } };
}
