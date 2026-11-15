import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFileTools } from '../server/modules/data/files.mjs';
import { createDesignTools, summarizeDesign } from '../server/modules/design/index.mjs';
import { checkAgentPackage } from '../server/modules/design/package.mjs';
import { chromiumEnv, createCheckHandler, createCheckQueue, runCheck, waitForGroupExit, validateCheck, HTML_LIMIT } from '../server/design-check/service.mjs';
import { AppError } from '../shared/errors.mjs';
import { nodeKeyHash, nodeHeaders } from '../server/modules/sharding/node-auth.mjs';
import { createToolService } from '../server/modules/tools/loader.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { ToolManager } from '../server/modules/tools/index.mjs';
import { CodexConnection } from '../server/modules/codex/connection.mjs';
import { tempRoot, installToolFixture } from './helpers.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const cleanReport = () => ({ schemaVersion: 1, status: 'completed', file: 'page.html', checks: [], errors: 0, warnings: 0, issues: [] });
const node = { nodeId: 'node-a', key: 'design-check-test-key-not-real' };
const env = { AGENT_NODE_ID: node.nodeId, AGENT_NODE_KEY: node.key };
function fileFixture(t, options = {}) {
  const root = tempRoot(t), workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'outputs'), { recursive: true });
  const files = createFileTools(root, { workspaceDir, sources: ['inputs', 'outputs'].map(locator => ({ locator, actions: ['read'], readOnly: locator === 'inputs' })), outputs: { directory: 'outputs', formats: ['md', 'txt', 'html'] }, ...options });
  fs.writeFileSync(path.join(workspaceDir, 'inputs/page.html'), '<html><body>示例</body></html>');
  return { root, files };
}
function packageFixture(t) {
  const { files, root } = fileFixture(t), directory = path.join(files.workspace, 'outputs/design/sample/package-v1');
  fs.mkdirSync(path.join(directory, 'agent'), { recursive: true });
  const definition = JSON.parse(fs.readFileSync(path.join(appRoot, 'agents/writing/agent.json')));
  definition.agent.skills = []; definition.agent.workflows = []; definition.agent.dataBindings = [];
  definition.agent.tools.allow = ['read_file']; delete definition.agent.knowledge;
  definition.agent.ui = { entry: 'ui/index.html', title: '测试页面' };
  definition.bindings.skills = {}; definition.bindings.sources = {}; delete definition.bindings.knowledgeBases;
  definition.bindings.workspaceDir = '../workspace';
  fs.writeFileSync(path.join(directory, 'agent/agent.json'), JSON.stringify(definition));
  fs.writeFileSync(path.join(directory, 'agent/role.md'), '你是测试助手。');
  fs.mkdirSync(path.join(directory, 'config'), { recursive: true });
  fs.copyFileSync(path.join(appRoot, 'config/models.json'), path.join(directory, 'config/models.json'));
  fs.mkdirSync(path.join(directory, 'agent/ui'));
  fs.writeFileSync(path.join(directory, 'agent/ui/index.html'), '<html><link rel="stylesheet" href="styles.css"><body><script src="app.js"></script></body></html>');
  fs.writeFileSync(path.join(directory, 'agent/ui/app.js'), "import { api } from '/ui/modules/api.mjs';\ndocument.body.textContent = '示例';");
  fs.writeFileSync(path.join(directory, 'agent/ui/styles.css'), 'body { margin: 0; }');
  manifest(directory);
  return { files, root, directory };
}
function manifest(directory) {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file);
      else if (file !== 'manifest.json') files.push({ path: file, sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex') });
    }
  };
  walk(''); fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files }));
}

test('设计工具拒绝绝对路径、穿越、隐藏路径、范围外文件及非 HTML', async t => {
  const { files } = fileFixture(t);
  const tools = createDesignTools({ files, env, fetcher: () => { throw new Error('不应联网'); } });
  for (const value of ['/tmp/a.html', '../inputs/page.html', 'inputs/../outputs/page.html', 'inputs/.hidden.html', 'inputs\\page.html', 'research/page.html', 'inputs/page.js', 'inputs//page.html', 'inputs/a\0.html']) await assert.rejects(tools.check_design({ path: value }));
  for (const value of ['outputs/design/x/package-v0', 'outputs/design/x/package-v1/extra', 'inputs/design/x/package-v1', 'outputs/design/../package-v1']) await assert.rejects(tools.check_agent_package({ path: value }));
  assert.throws(() => files.write_file({ path: 'outputs/report.json', content: '{}' }), /只支持|格式/);
});

test('设计文件拒绝符号链接和硬链接，读写仍受 Agent 范围约束', async t => {
  const { files } = fileFixture(t);
  const source = path.join(files.workspace, 'inputs/page.html');
  fs.symlinkSync(source, path.join(files.workspace, 'inputs/link.html'));
  fs.linkSync(source, path.join(files.workspace, 'inputs/hard.html'));
  for (const name of ['link', 'hard']) assert.throws(() => files.design_path({ path: `inputs/${name}.html` }), /链接/);
  const restricted = createFileTools(files.workspace, { workspaceDir: files.workspace, sources: [{ locator: 'inputs', actions: ['read'], readOnly: true }] });
  assert.throws(() => restricted.design_path({ path: 'outputs/page.html' }), /未授权/);
  assert.throws(() => restricted.write_design_report({ path: 'outputs/design/x/qa/a.json', report: {} }), /未授权/);
  fs.symlinkSync(path.join(files.workspace, 'inputs'), path.join(files.workspace, 'outputs/design'));
  assert.throws(() => files.write_design_report({ path: 'outputs/design/x/qa/a.json', report: {} }), /符号链接/);
});

test('check_design 使用节点认证，摘要最多 30 条，完整报告按项目保存且不覆盖', async t => {
  const { files } = fileFixture(t);
  fs.mkdirSync(path.join(files.workspace, 'outputs/design/demo'), { recursive: true });
  fs.copyFileSync(path.join(files.workspace, 'inputs/page.html'), path.join(files.workspace, 'outputs/design/demo/v1.html'));
  const report = { ...cleanReport(), errors: 32, warnings: 1, issues: Array.from({ length: 33 }, (_, i) => ({ severity: i === 32 ? 'warning' : 'error', code: 'text-overlap', screen: 'web-home', state: 'default', viewport: { width: 800, height: 600 }, element: 'p', reason: '文字重叠' })) };
  let requests = 0;
  const tools = createDesignTools({ files, env, fetcher: async (url, options) => {
    requests++; assert.equal(url.href, 'http://design-check:8091/check');
    assert.deepEqual(options.headers, { ...nodeHeaders(node), 'content-type': 'application/json' });
    assert.equal(options.redirect, 'error'); assert.match(JSON.parse(options.body).html, /示例/);
    return new Response(JSON.stringify(report));
  } });
  const summary = await tools.check_design({ path: 'outputs/design/demo/v1.html' });
  assert.equal(summary.errors, 32); assert.equal(summary.warnings, 1); assert.equal(summary.issues.length, 30); assert.equal(summary.truncated, true);
  assert.ok(summary.issues.every(i => i.fix && i.screen && i.state && i.viewport && i.element && i.reason));
  assert.match(summary.reportPath, /^outputs\/design\/demo\/qa\/v1-.*\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(files.workspace, summary.reportPath))).issues.length, 33);
  assert.throws(() => files.write_design_report({ path: summary.reportPath, report }), /未覆盖/);
  const next = await tools.check_design({ path: 'inputs/page.html' });
  assert.match(next.reportPath, /^outputs\/design\/page\/qa\//); assert.equal(requests, 2);
});

test('布局服务不可用、非法响应、超时均不伪造成功或重试', async t => {
  const { files } = fileFixture(t);
  for (const fetcher of [async () => { throw new Error('包含不应回显的内部信息'); }, async () => new Response('{}', { status: 503 }), async () => new Response('{}'), async () => new Response('{'), async () => new Response('{}', { status: 504 })]) {
    let calls = 0;
    const tools = createDesignTools({ files, env, fetcher: (...args) => { calls++; return fetcher(...args); } });
    await assert.rejects(tools.check_design({ path: 'inputs/page.html' }), /布局校验服务不可用|检查超时/);
    assert.equal(calls, 1);
  }
  assert.deepEqual(fs.readdirSync(path.join(files.workspace, 'outputs')), []);
  assert.throws(() => summarizeDesign({ ...cleanReport(), errors: 1 }), /报告格式无效/);
  fs.writeFileSync(path.join(files.workspace, 'inputs/page.html'), 'x'.repeat(HTML_LIMIT + 1));
  await assert.rejects(createDesignTools({ files, env }).check_design({ path: 'inputs/page.html' }), /上限/);
});

test('Chromium 环境仅含白名单变量，HOME 与 XDG 位于临时目录且 XDG 权限为 0700', t => {
  const directory = tempRoot(t);
  const environment = chromiumEnv(directory);
  assert.deepEqual(Object.keys(environment).sort(), ['PATH', 'LANG', 'TMPDIR', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CHROME_PATH'].sort());
  assert.deepEqual(environment, {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: directory, HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, '.config'), XDG_CACHE_HOME: path.join(directory, '.cache'),
    CHROME_PATH: '/usr/bin/chromium',
  });
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    const stat = fs.statSync(environment[key]);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.mode & 0o777, 0o700);
  }
});

const groupMissing = () => Object.assign(new Error('进程组已退出'), { code: 'ESRCH' });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('进程组立即返回 ESRCH 时无需等待', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const calls = [];
  await waitForGroupExit(123, { kill: (...args) => { calls.push(args); throw groupMissing(); } });
  assert.deepEqual(calls, [[-123, 0]]);
  assert.equal(Date.now(), 0);
});

test('进程组前 N 次存在时逐个等待 N 个间隔再返回', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const times = [];
  let settled = false;
  const work = waitForGroupExit(123, { intervalMs: 50, kill: (pid, signal) => {
    assert.equal(pid, -123); assert.equal(signal, 0);
    times.push(Date.now());
    if (times.length === 4) throw groupMissing();
    return true;
  } }).then(() => { settled = true; });
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(49); await nextTurn();
    assert.equal(times.length, i + 1); assert.equal(settled, false);
    t.mock.timers.tick(1); await nextTurn();
  }
  await work;
  assert.deepEqual(times, [0, 50, 100, 150]);
});

test('进程组始终存在时等待超时后抛出 503', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let settled = false;
  const work = assert.rejects(waitForGroupExit(123, { timeoutMs: 100, intervalMs: 50, kill: () => true }), error => {
    assert.ok(error instanceof AppError); assert.equal(error.status, 503);
    assert.equal(error.message, '检查进程未能及时退出，已停止本次检查。');
    settled = true; return true;
  });
  t.mock.timers.tick(50); await nextTurn();
  t.mock.timers.tick(49); await nextTurn(); assert.equal(settled, false);
  t.mock.timers.tick(1); await work;
});

test('进程组探测的非 ESRCH 错误原样抛出', async () => {
  const failure = Object.assign(new Error('无权探测进程组'), { code: 'EPERM' });
  await assert.rejects(waitForGroupExit(123, { kill: () => { throw failure; } }), error => error === failure);
});

function workerFixture() {
  const child = new EventEmitter(), calls = [];
  let directory, exited = false;
  Object.assign(child, { pid: 123, send() {} });
  return {
    child, calls,
    get directory() { return directory; },
    exitGroup() { exited = true; },
    dependencies: {
      fork: (_file, _args, options) => { directory = options.cwd; return child; },
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        if (exited) throw groupMissing();
        return true;
      },
    },
  };
}

function closeWorker(fixture, controller, outcome) {
  const failure = outcome === '超时' ? new AppError('检查超时', 504) : new AppError('调用已取消。', 499);
  if (outcome === '成功') fixture.child.emit('message', { report: cleanReport() });
  else if (outcome === '失败') fixture.child.emit('message', { error: '布局检查无法完成。' });
  else controller.abort(failure);
  fixture.child.emit('close', outcome === '成功' || outcome === '失败' ? 0 : null, controller.signal.aborted ? 'SIGKILL' : null);
  return failure;
}

for (const outcome of ['成功', '失败', '超时', '取消']) test(`runCheck ${outcome}在 worker close 后仍等待进程组退出再清理`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const fixture = workerFixture(), controller = new AbortController();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  let settled = false;
  const work = runCheck({ html: '<html>示例</html>' }, controller.signal, fixture.dependencies)
    .then(report => ({ report }), error => ({ error })).then(value => { settled = true; return value; });
  const failure = closeWorker(fixture, controller, outcome);
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(fs.existsSync(path.join(fixture.directory, 'page.html')), true);
  assert.deepEqual(fixture.calls.slice(-2), [[-123, 'SIGKILL'], [-123, 0]]);
  fixture.exitGroup(); t.mock.timers.tick(50);
  const value = await work;
  if (outcome === '成功') assert.deepEqual(value.report, cleanReport());
  else if (outcome === '失败') assert.equal(value.error.message, '布局检查无法完成。');
  else assert.equal(value.error, failure);
  assert.equal(fs.existsSync(fixture.directory), false);
});

for (const outcome of ['成功', '失败', '超时', '取消']) test(`runCheck ${outcome}遇到进程组退出超时的结果与日志`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const fixture = workerFixture(), controller = new AbortController(), logs = [];
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const work = runCheck({ html: '<html>不应出现在日志中的页面内容</html>' }, controller.signal, fixture.dependencies)
    .then(report => ({ report }), error => ({ error }));
  const failure = closeWorker(fixture, controller, outcome);
  await nextTurn();
  t.mock.timers.tick(5000);
  const value = await work;
  if (outcome === '成功') {
    assert.equal(value.error.status, 503);
    assert.equal(value.error.message, '检查进程未能及时退出，已停止本次检查。');
    assert.deepEqual(logs, []);
  } else {
    if (outcome === '失败') assert.equal(value.error.message, '布局检查无法完成。');
    else assert.equal(value.error, failure);
    assert.deepEqual(logs, [['布局检查进程组清理失败，已保留本次检查的原始失败原因。']]);
  }
  assert.equal(fs.existsSync(fixture.directory), false);
});

test('检查队列在 worker close 后等旧进程组退出才启动下一项', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const fixtures = [workerFixture(), workerFixture()], started = [];
  t.after(() => { for (const fixture of fixtures) if (fixture.directory) fs.rmSync(fixture.directory, { recursive: true, force: true }); });
  const check = createCheckQueue({ run: (input, signal) => {
    const fixture = fixtures[started.length]; started.push(input);
    return runCheck(input, signal, fixture.dependencies);
  } });
  const a = check({ html: '<html>第一项</html>' }), b = check({ html: '<html>第二项</html>' });
  await nextTurn();
  closeWorker(fixtures[0], new AbortController(), '成功');
  await nextTurn();
  assert.equal(started.length, 1);
  fixtures[0].exitGroup(); t.mock.timers.tick(50);
  await a; await nextTurn();
  assert.equal(started.length, 2);
  assert.equal(fs.existsSync(fixtures[0].directory), false);
  fixtures[1].exitGroup(); closeWorker(fixtures[1], new AbortController(), '成功');
  assert.deepEqual(await b, cleanReport());
});

test('检查接口按解码后的 UTF-8 字节限制 2 MiB，并严格验证视口', () => {
  assert.equal(validateCheck({ html: 'x'.repeat(HTML_LIMIT) }).html.length, HTML_LIMIT);
  assert.throws(() => validateCheck({ html: '中'.repeat(Math.floor(HTML_LIMIT / 3) + 1) }), /2 MiB/);
  for (const body of [{}, { html: '' }, { html: 'x', extra: true }, { html: 'x', viewports: [] }, { html: 'x', viewports: null }, ...[null, {}, { width: 0, height: 10 }, { width: 10.5, height: 10 }, { width: 10, height: 10, script: 'x' }].map(v => ({ html: 'x', viewports: [v] }))]) assert.throws(() => validateCheck(body));
  assert.deepEqual(validateCheck({ html: 'x', viewports: [{ width: 800, height: 600 }] }).viewports, [{ width: 800, height: 600 }]);
});

test('检查队列始终串行；超时取消后等待清理，过期排队任务不执行', async () => {
  const pending = [], started = [];
  const check = createCheckQueue({ timeoutMs: 20, run: (value, signal) => { started.push(value); return new Promise(resolve => pending.push({ resolve, signal })); } });
  const a = assert.rejects(check('a'), /检查超时/);
  const b = assert.rejects(check('b'), /检查超时/);
  await Promise.all([a, b]);
  assert.deepEqual(started, ['a']); assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(cleanReport());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a']);
  const c = check('c');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'c']); pending[1].resolve(cleanReport());
  assert.equal((await c).errors, 0);
});

async function request(handler, body, headers = nodeHeaders(node), method = 'POST', url = '/check') {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { headers: { 'content-type': 'application/json', ...headers }, method, url });
  const res = new EventEmitter();
  Object.assign(res, { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); this.writableEnded = true; } });
  await handler(req, res); return res;
}
test('检查 HTTP 处理器复用节点认证并区分 403、400、413、404、504', async () => {
  let called = 0;
  const handler = createCheckHandler({ keyHashes: { 'node-a': nodeKeyHash(node.key) }, check: async () => { called++; return cleanReport(); } });
  for (const headers of [{}, { 'x-node-id': 'node-a', 'x-node-key': 'wrong' }, { ...nodeHeaders(node), 'x-node-id': 'node-b' }]) assert.equal((await request(handler, { html: 'x' }, headers)).status, 403);
  assert.equal(called, 0);
  assert.equal((await request(handler, '{')).status, 400);
  assert.equal((await request(handler, { html: 'x'.repeat(HTML_LIMIT + 1) })).status, 413);
  assert.equal((await request(handler, {}, nodeHeaders(node), 'POST', '/unknown')).status, 404);
  assert.equal((await request(handler, { html: 'x' })).status, 200); assert.equal(called, 1);
  const timed = createCheckHandler({ keyHashes: { 'node-a': nodeKeyHash(node.key) }, check: async () => { throw Object.assign(new Error('检查超时'), { status: 504 }); } });
  assert.equal((await request(timed, { html: 'x' })).body.error, '检查超时');
});

test('完整代码包通过 agent-check、清单和 UI 静态校验，动态工具返回结构化结果', async t => {
  const { directory, files } = packageFixture(t);
  assert.deepEqual(checkAgentPackage(directory), { ok: true, errors: 0, issues: [] });
  assert.equal((await createDesignTools({ files }).check_agent_package({ path: 'outputs/design/sample/package-v1/' })).ok, true);
});

for (const [name, mutate, code] of [
  ['包根 UI 目录', d => {
    fs.mkdirSync(path.join(d, 'ui'));
    fs.writeFileSync(path.join(d, 'ui/index.html'), '<html><body>放错位置的前端</body></html>');
    manifest(d);
  }, 'ui-location'],
  ['前端未声明 ui', d => {
    const file = path.join(d, 'agent/agent.json'), definition = JSON.parse(fs.readFileSync(file));
    delete definition.agent.ui;
    fs.writeFileSync(file, JSON.stringify(definition));
    manifest(d);
  }, 'ui-undeclared'],
  ['错误 Agent 字段', d => fs.writeFileSync(path.join(d, 'agent/agent.json'), '{}'), 'agent-check'],
  ['缺失模型目录', d => fs.unlinkSync(path.join(d, 'config/models.json')), 'agent-check'],
  ['清单 SHA 不一致', d => fs.appendFileSync(path.join(d, 'agent/ui/app.js'), '\n// 修改'), 'manifest-hash'],
  ['清单遗漏文件', d => fs.writeFileSync(path.join(d, 'extra.md'), '新增'), 'manifest-unlisted'],
  ['清单列出缺失文件', d => fs.unlinkSync(path.join(d, 'agent/ui/app.js')), 'manifest-missing'],
  ['清单路径越界', d => fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ files: [{ path: '../outside', sha256: '0'.repeat(64) }] })), 'manifest-entry'],
  ['清单结构错误', d => fs.writeFileSync(path.join(d, 'manifest.json'), '{"files":{}}'), 'manifest-format'],
  ['宿主脚本', d => fs.writeFileSync(path.join(d, 'install.sh'), '#!/bin/sh\nexit 0'), 'host-script'],
  ['改名宿主脚本', d => fs.writeFileSync(path.join(d, 'install.txt'), '#!/usr/bin/env bash\nexit 0'), 'host-script'],
  ['UI 非白名单', d => fs.writeFileSync(path.join(d, 'agent/ui/font.ttf'), 'fixture'), 'ui-type'],
  ['内联脚本', d => fs.writeFileSync(path.join(d, 'agent/ui/index.html'), '<script>alert(1)</script>'), 'ui-inline'],
  ['src 脚本带正文', d => fs.writeFileSync(path.join(d, 'agent/ui/index.html'), '<script src="app.js">alert(1)</script>'), 'ui-inline'],
  ['内联样式', d => fs.writeFileSync(path.join(d, 'agent/ui/index.html'), '<style>p{color:red}</style><p style="color:red" onclick="x()">文本</p>'), 'ui-inline'],
  ['实体外链', d => fs.writeFileSync(path.join(d, 'agent/ui/index.html'), '<img src="&#104;ttps://example.com/a.png">'), 'ui-external'],
  ['绝对地址不能借解析域名冒充同源', d => fs.writeFileSync(path.join(d, 'agent/ui/index.html'), '<img src="https://package.invalid/a.png"><img src="//package.invalid/b.png">'), 'ui-external'],
  ['srcset 外链', d => fs.writeFileSync(path.join(d, 'agent/ui/index.html'), '<img srcset="a.png 1x, //example.com/b.png 2x">'), 'ui-external'],
  ['CSS 外链', d => fs.writeFileSync(path.join(d, 'agent/ui/styles.css'), '@import "https://example.com/a.css";'), 'ui-external'],
  ['JS 外链', d => fs.writeFileSync(path.join(d, 'agent/ui/app.js'), 'import "https://example.com/a.js";'), 'ui-external'],
  ['符号链接', d => fs.symlinkSync('role.md', path.join(d, 'agent/link.md')), 'unsafe-file'],
  ['硬链接', d => fs.linkSync(path.join(d, 'agent/role.md'), path.join(d, 'agent/hard.md')), 'unsafe-file'],
]) test(`代码包违规夹具：${name}`, t => {
  const { directory } = packageFixture(t); mutate(directory);
  const report = checkAgentPackage(directory);
  assert.equal(report.ok, false); assert.ok(report.issues.some(i => i.code === code), JSON.stringify(report));
  assert.ok(report.issues.every(i => i.reason && i.fix));
});

test('设计工具仅对 tools.allow 声明者开放，工具快照可加载，普通 Agent 不增加工具', async t => {
  const root = installToolFixture(tempRoot(t));
  const file = path.join(root, 'agents/writing/agent.json');
  const denied = await createToolService(root, { agent: new AgentDefinition(root) });
  assert.ok(!denied.specs.some(s => s.name.startsWith('check_')));
  assert.equal((await denied.call({ tool: 'check_design', arguments: { path: 'inputs/page.html' } })).success, false);
  assert.equal(ToolManager.prototype.connection.call({ server: { url: 'http://localhost' } }, denied).tool_timeout_sec, 30);
  const definition = JSON.parse(fs.readFileSync(file)); definition.agent.tools.allow.push('check_design', 'check_agent_package');
  fs.writeFileSync(file, JSON.stringify(definition));
  const allowed = await createToolService(root, { agent: new AgentDefinition(root), snapshotDir: path.join(root, 'snapshot') });
  assert.equal(allowed.specs.filter(s => s.name.startsWith('check_')).length, 2);
  assert.match(allowed.specs.find(s => s.name === 'check_design').description, /不能声称已通过/);
  assert.throws(() => allowed.validate('check_design', { path: 'inputs/a.html', userId: 'forged' }), /参数不合法/);
  assert.equal(ToolManager.prototype.connection.call({ server: { url: 'http://localhost' } }, allowed).tool_timeout_sec, 60);
  const timeout = await allowed.call({ tool: 'check_design', arguments: { path: 'inputs/page.html' } }, { signal: AbortSignal.abort(new DOMException('请求超时', 'TimeoutError')) });
  assert.equal(JSON.parse(timeout.contentItems[0].text).error, '检查超时');
});

test('动态布局工具获得 60 秒，普通工具仍在 30 秒截止', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rpc = new CodexConnection({ launch: { timeoutMs: 1000 }, runtime: { runDir: tempRoot(t) }, redact: String });
  const replies = []; rpc.send = message => replies.push(message);
  rpc.toolHandler = () => new Promise(() => {});
  for (const [id, tool] of [[1, 'check_design'], [2, 'read_file']]) rpc.receive({ id, method: 'item/tool/call', params: { threadId: 't', turnId: 'r', callId: String(id), tool, arguments: {} } });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30000); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.map(r => r.id), [2]);
  t.mock.timers.tick(30000); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.map(r => r.id), [2, 1]);
  assert.match(replies[1].result.contentItems[0].text, /检查超时/);
  await rpc.close();
});

test('studio 服务固定资源和内部网络，Chromium 不接收明文节点密钥', () => {
  const compose = fs.readFileSync(path.join(appRoot, 'compose.yaml'), 'utf8');
  const service = compose.split('  design-check:\n')[1].split('  setup:\n')[0];
  for (const expected of ['profiles: [studio]', 'mem_limit: 512m', 'cap_drop: [ALL]', 'read_only: true', 'networks: [design-check]', 'healthcheck:']) assert.ok(service.includes(expected), expected);
  assert.doesNotMatch(service, /ports:|volumes:|cap_add:|AGENT_NODE_KEY:/);
  assert.match(compose, /networks:\n  design-check:\n    internal: true/);
  const image = fs.readFileSync(path.join(appRoot, 'server/design-check/Dockerfile'), 'utf8');
  assert.match(image, /APT_MIRROR/); assert.match(image, /apt-get install.*chromium/); assert.match(image, /AS prototype[\s\S]*npm ci --prefix server\/design-check\/template/);
  assert.doesNotMatch(image.split(' AS browser')[1], /npm (?:ci|install)/);
});
