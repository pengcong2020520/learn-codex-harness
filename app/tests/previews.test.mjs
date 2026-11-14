import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createPreview, verifyPreview, previewHash } from '../server/modules/http/previews.mjs';
import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { currentIdentity, runOwner } from '../server/modules/accounts/context.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { Response, httpFixture, fixedAccounts, OWNER_A, OWNER_B } from './accounts-fixture.mjs';

// 保留真实 HTTP 的二进制响应语义；JSON 响应仍解析，便于检查状态。
export async function previewRequest(http, url, { body, headers = {}, source = 'peer' } = {}) {
  const response = new Response();
  response.end = function (body) {
    this.bytes = Buffer.from(body || '');
    if (this.headers['content-type']?.startsWith('application/json')) this.body = JSON.parse(this.bytes);
    this.destroyed = true; this.emit('close');
  };
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method: body === undefined ? 'GET' : 'POST', url, socket: { remoteAddress: source },
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  });
  await http.handle(req, response);
  return response;
}
const auth = { authorization: 'Bearer unit-token' };
function fixture(t, deployment = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = randomBytes(32).toString('hex');
  const sources = ['outputs', 'inputs'].map(locator => ({ id: locator, locator, actions: ['read', 'create'] }));
  const files = createUserFileTools(root, { workspaceDir: root, sources, outputs: { directory: 'outputs', formats: ['html', 'md', 'png', 'jpeg', 'webp'] } });
  for (const owner of [OWNER_A, OWNER_B]) runOwner(owner, () => {
    files.write_file({ path: 'outputs/page.html', content: `<html>${owner}</html>` });
    fs.writeFileSync(path.join(files.workspace, 'inputs/picture.jpg'), Buffer.from([255, 216, 255]));
    fs.writeFileSync(path.join(files.workspace, 'outputs/a.txt'), '普通文本');
  });
  const agent = { assertCurrent() {}, sources, outputs: { directory: 'outputs' }, definition: { agent: { id: 'test' }, bindings: {} } };
  const gate = new PermissionGate({ agent, scope: { get ownerId() { return currentIdentity().userId; } } });
  const guarded = Object.assign(Object.create(files), { read_preview(args) { gate.check('read', args); return files.read_preview(args); } });
  const http = httpFixture(fixedAccounts(), { files: guarded, gate, config: { previewSecret: secret, launch: {}, deployment, allowedOrigins: ['https://example.com'] } });
  return { root, files, secret, http, agent };
}
const htmlCsp = "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const expectedHeaders = (type, csp) => ({ 'content-type': type, 'content-security-policy': csp,
  'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' });

test('预览：签发需认证和来源白名单；匿名读取保留原始字节与全部响应头', async t => {
  const { http, secret } = fixture(t);
  assert.equal((await previewRequest(http, '/previews', { body: { path: 'outputs/page.html' } })).statusCode, 401);
  assert.equal((await previewRequest(http, '/previews', { body: { path: 'outputs/page.html' }, headers: { ...auth, origin: 'https://evil.example.com' } })).statusCode, 403);
  const issued = await previewRequest(http, '/previews', { body: { path: 'outputs/page.html' }, headers: { ...auth, origin: 'https://example.com' } });
  assert.equal(issued.statusCode, 200);
  const claim = verifyPreview(secret, issued.body.url.slice(9));
  assert.equal(claim.userId, OWNER_A); assert.ok(Math.abs(issued.body.expiresAt - Date.now() - 600000) < 2000);
  const result = await previewRequest(http, issued.body.url, { headers: { authorization: 'Bearer ignored' } });
  assert.equal(result.statusCode, 200); assert.equal(result.bytes.toString(), `<html>${OWNER_A}</html>`);
  assert.deepEqual(result.headers, expectedHeaders('text/html; charset=utf-8', htmlCsp));
  const other = createPreview(secret, OWNER_B, 'outputs/page.html', Buffer.from(`<html>${OWNER_B}</html>`));
  const otherResponse = await previewRequest(http, other.url, { headers: auth });
  assert.equal(otherResponse.statusCode, 200); assert.equal(otherResponse.bytes.toString(), `<html>${OWNER_B}</html>`, '只按签名用户读取，不继承请求头身份');
  assert.equal((await previewRequest(http, issued.body.url, { headers: { origin: 'https://evil.example.com' } })).statusCode, 403);
  for (const [extension, type] of [['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const { files } = fixture(t);
    // 内容按原始字节预览，格式由扩展名决定，nosniff 防止类型推测。
    runOwner(OWNER_A, () => fs.writeFileSync(path.join(files.workspace, `inputs/test.${extension}`), Buffer.from([1, 2, 3])));
    const imageHttp = httpFixture(fixedAccounts(), { files, config: { previewSecret: secret, deployment: {} } });
    const image = await previewRequest(imageHttp, '/previews', { body: { path: `inputs/test.${extension}` }, headers: auth });
    const response = await previewRequest(imageHttp, image.body.url);
    assert.equal(response.statusCode, 200); assert.deepEqual([...response.bytes], [1, 2, 3]);
    assert.deepEqual(response.headers, expectedHeaders(type, "default-src 'none'; img-src 'self'; sandbox"));
  }
});

test('预览：任意字段篡改、错签名、过期、非法载荷一律 404', async t => {
  const { http, secret } = fixture(t);
  const { body: issued } = await previewRequest(http, '/previews', { body: { path: 'outputs/page.html' }, headers: auth });
  const [encoded, signature] = issued.url.slice(9).split('.'), claim = JSON.parse(Buffer.from(encoded, 'base64url'));
  for (const [key, value] of Object.entries({ userId: OWNER_B, path: 'inputs/picture.jpg', expiresAt: Date.now() + 3600000, sha256: '0'.repeat(64) })) {
    const payload = Buffer.from(JSON.stringify({ ...claim, [key]: value })).toString('base64url');
    assert.equal((await previewRequest(http, `/preview/${payload}.${signature}`)).statusCode, 404, key);
  }
  const expired = createPreview(secret, OWNER_A, claim.path, Buffer.from('x'), Date.now() - 600001);
  const wrong = createPreview(randomBytes(32).toString('hex'), OWNER_A, claim.path, Buffer.from('x'));
  for (const url of [expired.url, wrong.url, '/preview/bad', '/preview/..bad.signature']) assert.equal((await previewRequest(http, url)).statusCode, 404);
  for (const changes of [{ userId: '../bad' }, { path: '../outputs/page.html' }, { path: 'outputs/a.txt' }, { expiresAt: 'forever' }]) {
    const payload = Buffer.from(JSON.stringify({ ...claim, ...changes })).toString('base64url');
    const mac = createHmac('sha256', secret).update(payload).digest('base64url');
    assert.equal((await previewRequest(http, `/preview/${payload}.${mac}`)).statusCode, 404);
  }
});

test('预览：越界、链接、目录、非白名单及门禁拒绝都是 404，文件变化返回 410', async t => {
  const { http, files, secret, agent } = fixture(t);
  const workspace = runOwner(OWNER_A, () => files.workspace);
  fs.symlinkSync(path.join(workspace, 'outputs/page.html'), path.join(workspace, 'outputs/link.html'));
  fs.symlinkSync(path.join(workspace, 'outputs'), path.join(workspace, 'inputs/link'));
  fs.linkSync(path.join(workspace, 'outputs/page.html'), path.join(workspace, 'outputs/hard.html'));
  fs.mkdirSync(path.join(workspace, 'outputs/folder.html'));
  for (const locator of ['../outputs/page.html', '/outputs/page.html', 'outputs/../inputs/picture.jpg', 'outputs/link.html', 'inputs/link/page.html', 'outputs/hard.html', 'outputs/folder.html', 'outputs/a.txt', 'outputs/a.svg', 'research/a.html', 'outputs//page.html']) {
    assert.equal((await previewRequest(http, '/previews', { body: { path: locator }, headers: auth })).statusCode, 404, locator);
    // 对合法签名的坏路径也必须重新核对文件，不能只信签发时的结果。
    const payload = Buffer.from(JSON.stringify({ userId: OWNER_A, path: locator, expiresAt: Date.now() + 60000, sha256: previewHash('x') })).toString('base64url');
    const mac = createHmac('sha256', secret).update(payload).digest('base64url');
    assert.equal((await previewRequest(http, `/preview/${payload}.${mac}`)).statusCode, 404, locator);
  }
  fs.unlinkSync(path.join(workspace, 'outputs/hard.html'));
  const { body: issued } = await previewRequest(http, '/previews', { body: { path: 'outputs/page.html' }, headers: auth });
  fs.writeFileSync(path.join(workspace, 'outputs/page.html'), '<html>修改</html>');
  assert.equal((await previewRequest(http, issued.url)).statusCode, 410);
  agent.sources = [];
  assert.equal((await previewRequest(http, issued.url)).statusCode, 404);
  assert.equal((await previewRequest(http, '/previews', { body: { path: 'outputs/page.html' }, headers: auth })).statusCode, 404);
});

test('预览：POST 计入每用户额度，GET 的有效及无效令牌计入来源额度', async t => {
  const { http, secret } = fixture(t, { rateLimit: 1 });
  const issued = await previewRequest(http, '/previews', { body: { path: 'outputs/page.html' }, headers: auth });
  assert.equal(issued.statusCode, 200);
  assert.equal((await previewRequest(http, '/previews', { body: { path: 'inputs/picture.jpg' }, headers: auth, source: 'another' })).statusCode, 429);
  assert.equal((await previewRequest(http, issued.body.url)).statusCode, 200);
  assert.equal((await previewRequest(http, issued.body.url)).statusCode, 429);
  assert.equal((await previewRequest(http, '/preview/invalid', { source: 'bad-peer' })).statusCode, 404);
  assert.equal((await previewRequest(http, '/preview/invalid', { source: 'bad-peer' })).statusCode, 429);
  assert.ok(secret);
});

test('工作区列表：文件大小与修改时间来自 lstat，符号链接不跟随', t => {
  const { files } = fixture(t);
  runOwner(OWNER_A, () => {
    fs.symlinkSync('missing', path.join(files.workspace, 'outputs/link'));
    const { entries } = files.list_files({ path: 'outputs' });
    const html = entries.find(entry => entry.name === 'page.html');
    assert.equal(html.size, Buffer.byteLength(`<html>${OWNER_A}</html>`));
    assert.ok(Number.isFinite(Date.parse(html.updatedAt)));
    assert.equal(entries.find(entry => entry.name === 'link').type, 'blocked-link');
  });
});

test('预览密钥只在服务端使用，模型进程环境和日志不含密钥', async t => {
  const { secret } = fixture(t);
  const { loadServerConfig, createLogRedactor } = await import('../server/modules/config/index.mjs');
  const { tempRoot, installToolFixture } = await import('./helpers.mjs');
  const config = loadServerConfig(installToolFixture(tempRoot(t)), { AGENT_PREVIEW_SECRET: secret });
  assert.ok(config.previewSecret === secret);
  assert.equal(config.launch.env.AGENT_PREVIEW_SECRET, undefined);
  const redact = createLogRedactor('', [config.previewSecret]);
  assert.equal(redact(`出错 ${secret}`), '出错 [REDACTED]');
  assert.equal(createLogRedactor()({ AGENT_PREVIEW_SECRET: secret, previewSecret: secret }), '{"AGENT_PREVIEW_SECRET":"[REDACTED]","previewSecret":"[REDACTED]"}');
});
