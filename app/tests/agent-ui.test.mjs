import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { validateDefinition } from '../server/modules/agents/schema.mjs';
import { checkAgent } from '../scripts/agent-check.mjs';
import { httpFixture, fixedAccounts } from './accounts-fixture.mjs';
import { createShardedHandler } from '../server/modules/sharding/http.mjs';
import { tempRoot } from './helpers.mjs';
import { loginNext } from '../web/modules/login.mjs';
import { CONTRACTS, digest } from '../server/modules/agents/contracts.mjs';

const example = new URL('../examples/custom-ui/', import.meta.url);
function setup(t) {
  const root = tempRoot(t);
  fs.cpSync(example, path.join(root, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'));
  fs.copyFileSync(new URL('../config/models.json', import.meta.url), path.join(root, 'config/models.json'));
  const file = path.join(root, 'agent/agent.json');
  const definition = JSON.parse(fs.readFileSync(file));
  definition.bindings.workspaceDir = '../workspace';
  const save = () => fs.writeFileSync(file, JSON.stringify(definition));
  save();
  return { root, file, definition, save, ui: path.join(root, 'agent/ui') };
}
async function request(http, url, method = 'GET') {
  const response = new EventEmitter();
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; response.headersSent = true; };
  response.end = body => { response.body = body?.toString() || ''; };
  await http.handle({ url, method, headers: {}, socket: { remoteAddress: 'peer' } }, response);
  return response;
}
function service(t, agent) {
  const config = { agent, launch: {}, deployment: {} };
  const http = httpFixture(fixedAccounts(), { config });
  t.after(() => http.close());
  return { config, http };
}

test('Agent UI schema：可选声明、字段类型与越界路径', t => {
  const { definition } = setup(t);
  assert.doesNotThrow(() => validateDefinition(definition));
  for (const entry of ['/ui/index.html', '../ui/index.html', 'index.html', 'ui/../role.md', 'ui/a/../../role.md', 'ui/./index.html', 'ui//index.html', 'ui/', 'ui\\index.html', 'ui/%2e%2e/a.html', 'ui/a?b.html', 'ui/a#b.html', 'ui/a\0.html', 'ui/C:/a.html', 'ui/.hidden.html', 'ui/foo..html', 'ui/index.html\n', 'ui/index.html\r\n']) {
    assert.throws(() => validateDefinition({ ...definition, agent: { ...definition.agent, ui: { entry, title: '标题' } } }), /Agent 定义无效/, entry);
  }
  for (const ui of [null, 'ui/index.html', {}, { entry: 'ui/index.html', title: 1 }, { entry: 'ui/index.html', title: '标题', extra: true }]) {
    assert.throws(() => validateDefinition({ ...definition, agent: { ...definition.agent, ui } }));
  }
  delete definition.agent.ui;
  assert.doesNotThrow(() => validateDefinition(definition));
});

test('Agent UI 装配与 agent:check：入口缺失、链接、超限和工作区重叠均拒绝', t => {
  const { root, file, ui, definition, save } = setup(t);
  assert.doesNotThrow(() => new AgentDefinition(root, file));
  assert.deepEqual(checkAgent(file, { root }).filter(row => row.level === 'error'), []);
  const entry = path.join(ui, 'index.html');
  fs.renameSync(entry, path.join(ui, 'original.html'));
  for (const kind of ['missing', 'symlink', 'hardlink', 'large']) {
    if (kind === 'symlink') fs.symlinkSync('original.html', entry);
    if (kind === 'hardlink') fs.linkSync(path.join(ui, 'original.html'), entry);
    if (kind === 'large') fs.writeFileSync(entry, Buffer.alloc(2 * 1024 * 1024 + 1));
    assert.throws(() => new AgentDefinition(root, file), undefined, kind);
    assert.ok(checkAgent(file, { root }).some(row => row.level === 'error' && row.title.includes('agent.ui.entry')), kind);
    if (kind !== 'missing') fs.unlinkSync(entry);
  }
  fs.renameSync(path.join(ui, 'original.html'), entry);
  fs.renameSync(ui, ui + '-real'); fs.symlinkSync('ui-real', ui);
  assert.throws(() => new AgentDefinition(root, file));
  fs.unlinkSync(ui); fs.renameSync(ui + '-real', ui);
  definition.bindings.workspaceDir = 'ui'; save();
  assert.throws(() => new AgentDefinition(root, file), /工作区/);
});

test('Agent UI 展示配置沿用 name 的描述符规则且不提升 CONTRACTS', t => {
  const { root, file, definition, save } = setup(t);
  const activate = () => { const agent = new AgentDefinition(root, file); agent.activate('fixture-tools'); return agent; };
  const withUi = activate();
  const { version, instructions, ...effective } = definition.agent;
  assert.equal(withUi.descriptor.contracts, CONTRACTS);
  assert.equal(CONTRACTS.agent, 2);
  assert.equal(withUi.descriptor.definitionHash, digest(effective));
  definition.agent.ui.title = '另一个标题'; save();
  assert.notEqual(activate().descriptor.hash, withUi.descriptor.hash);
  delete definition.agent.ui; save();
  const withoutUi = activate();
  assert.notEqual(withoutUi.descriptor.hash, withUi.descriptor.hash);
  const { version: _version, instructions: _instructions, ...oldEffective } = definition.agent;
  assert.equal(withoutUi.descriptor.definitionHash, digest(oldEffective));
});

test('Agent UI HTTP：匿名读取白名单、2 MiB 边界及与 /ui/ 相同的 CSP', async t => {
  const { root, file, ui } = setup(t), { http } = service(t, new AgentDefinition(root, file));
  const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  const types = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', json: 'application/json' };
  for (const [ext, type] of Object.entries(types)) {
    fs.writeFileSync(path.join(ui, `test.${ext}`), 'fixture');
    const res = await request(http, `/app/test.${ext}`);
    assert.equal(res.status, 200, ext);
    assert.equal(res.headers['content-type'].split(';')[0], type);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-security-policy'], caddy.match(/Content-Security-Policy "([^"]+)"/)[1]);
  }
  assert.match((await request(http, '/app/')).body, /自定义 Agent/);
  fs.writeFileSync(path.join(ui, 'limit.js'), Buffer.alloc(2 * 1024 * 1024));
  assert.equal((await request(http, '/app/limit.js')).status, 200);
  fs.appendFileSync(path.join(ui, 'limit.js'), 'x');
  assert.equal((await request(http, '/app/limit.js')).status, 404);
  assert.equal((await request(http, '/sessions')).status, 401);
});

test('Agent UI HTTP：越界、隐藏文件、类型与目录和链接均拒绝', async t => {
  const { root, file, ui } = setup(t), { http } = service(t, new AgentDefinition(root, file));
  fs.writeFileSync(path.join(ui, 'blocked.txt'), 'fixture');
  fs.symlinkSync('../role.md', path.join(ui, 'link.js'));
  fs.linkSync(path.join(ui, 'app.js'), path.join(ui, 'hard.js'));
  fs.mkdirSync(path.join(ui, 'directory.js'));
  fs.symlinkSync('..', path.join(ui, 'outside'));
  for (const url of ['/app/../role.md', '/app/%2e%2e/role.md', '/app/%252e%252e/role.md', '/app/a/../../role.md', '/app/%2fetc/passwd', '/app/..%5crole.md', '/app//index.html', '/app/.hidden.js', '/app/%00.js', '/app/%ff.js', '/app/blocked.txt', '/app/link.js', '/app/hard.js', '/app/directory.js', '/app/outside/ui/index.html']) {
    assert.ok([400, 404].includes((await request(http, url)).status), url);
  }
  assert.equal((await request(http, '/app/', 'POST')).status, 404);
});

test('Agent UI 路由：根路径、未声明 404、分片匿名请求留在当前节点', async t => {
  const { root, file } = setup(t);
  for (const agent of [undefined, new AgentDefinition(root, file)]) {
    const { config, http } = service(t, agent);
    const shard = { handle: createShardedHandler({}, { isReady: () => true, app: { config, http } }, {}, {}) };
    for (const handler of [http, shard]) {
      const res = await request(handler, '/');
      assert.equal(res.status, 302); assert.equal(res.headers.location, agent ? '/app/' : '/ui/');
      assert.equal((await request(handler, '/app/')).status, agent ? 200 : 404);
      for (const url of ['/app/../health', '/app/%2e%2e/health', '/app/../ready', '/app/%2e%2e/internal/revision'])
        assert.equal((await request(handler, url)).status, 404, url);
    }
  }
});

test('登录 next：只接受 /app/ 下同源路径，拒绝规范化越界与伪装 URL', () => {
  for (const value of ['/app/', '/app/index.html', '/app/nested/page.html?q=1#detail']) assert.equal(loginNext(value), value);
  for (const value of [null, '', '/app', '/ui/', '//example.com/app/', 'https://example.com/app/', '/app/../ui/', '/app/%2e%2e/ui/', '/app/%252e%252e/ui/', '/app/\\example.com', '/app/%5cfoo', '/app/%2f../ui/', '/app/\nfoo', ' /app/', '/app/%00', '/app/%ff']) assert.equal(loginNext(value), null, String(value));
});
