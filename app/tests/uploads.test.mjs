import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { currentIdentity, runOwner } from '../server/modules/accounts/context.mjs';
import { uploadInfo } from '../shared/uploads.mjs';
import { Response, httpFixture, OWNER_A, OWNER_B } from './accounts-fixture.mjs';
import { tempRoot } from './helpers.mjs';
import { TEST_IMAGE } from '../scripts/gateway-check.mjs';
import { bufferBody } from '../server/modules/sharding/routing.mjs';

export const samples = {
  md: Buffer.from('# 用户 PRD\n正文'), txt: Buffer.from('文本内容'), png: Buffer.from(TEST_IMAGE.split(',')[1], 'base64'),
  jpeg: Buffer.from([255,216,255,224]), jpg: Buffer.from([255,216,255,224]), webp: Buffer.from('RIFF0000WEBPVP8 '),
};
async function put(http, locator, bytes, { type = uploadInfo(locator).contentType, token = 'alice', origin = 'https://example.com', method = 'PUT' } = {}) {
  const request = Object.assign(Readable.from([bytes]), { method, url: `/workspace/files?path=${encodeURIComponent(locator)}`,
    headers: { authorization: token ? `Bearer ${token}` : '', 'content-type': type, origin }, socket: { remoteAddress: 'peer' } });
  const response = new Response(); await http.handle(request, response); return response;
}
function setup(t, deployment = {}) {
  const root = tempRoot(t), sources = [{ id: 'originals', locator: 'inputs', actions: ['read'], readOnly: true }];
  const files = createUserFileTools(root, { workspaceDir: path.join(root, 'workspace'), sources, outputs: { directory: 'outputs', formats: ['md'] } });
  const agent = { assertCurrent() {}, sources, outputs: { directory: 'outputs' }, definition: { agent: { id: 'test' }, bindings: {} } };
  const gate = new PermissionGate({ agent, scope: { get ownerId() { return currentIdentity().userId; } } });
  const accounts = { async authenticate(header) {
    if (!['Bearer alice', 'Bearer bob'].includes(header)) throw Object.assign(new Error('请重新登录。'), { status: 401 });
    return { userId: header === 'Bearer alice' ? OWNER_A : OWNER_B };
  } };
  const http = httpFixture(accounts, { gate, files, config: { launch: {}, deployment, allowedOrigins: ['https://example.com'] }, log() {} });
  t.after(() => http.close());
  return { http, files, gate, agent };
}
for (const [extension, bytes] of Object.entries(samples)) test(`上传 ${extension}：原始字节、摘要、只读输入区与生产文件权限`, async t => {
  const { http, files } = setup(t), locator = `inputs/uploads/参考_v1-文件.${extension}`;
  const result = await put(http, locator, bytes);
  assert.equal(result.statusCode, 201, JSON.stringify(result.body));
  assert.deepEqual(result.body, { path: locator, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  runOwner(OWNER_A, () => {
    assert.deepEqual(files.read_upload({ path: locator }).content, bytes);
    assert.throws(() => files.write_file({ path: 'inputs/模型写入.md', content: '不允许' }), /未授权/);
    files.write_file({ path: 'outputs/normal.md', content: '普通产物' });
    const uploaded = fs.statSync(path.join(files.workspace, locator)), normal = fs.statSync(path.join(files.workspace, 'outputs/normal.md'));
    assert.equal(uploaded.uid, normal.uid); assert.equal(uploaded.gid, normal.gid); assert.equal(uploaded.mode, normal.mode);
    assert.ok(files.list_files({ path: 'inputs/uploads' }).entries.some(entry => entry.name === locator.split('/').at(-1)));
    if (uploadInfo(locator).image) assert.deepEqual(files.read_preview({ path: locator }).content, bytes);
  });
});
test('上传：路径、文件名、类型、魔数、UTF-8、大小、同名分别拒绝', async t => {
  const { http } = setup(t);
  for (const locator of ['../x.md', 'outputs/x.md', 'inputs/uploads/sub/x.md', 'inputs/uploads/.x.md', 'inputs/uploads/a b.md', 'inputs/uploads/a\\b.md', 'inputs/uploads/a.svg', 'inputs/uploads/a.constructor', 'inputs/uploads/' + 'a'.repeat(98) + '.md']) {
    assert.equal((await put(http, locator, samples.md, { type: 'text/markdown' })).statusCode, 400, locator);
  }
  assert.equal((await put(http, 'inputs/uploads/mismatch.png', samples.png, { type: 'image/jpeg' })).statusCode, 415);
  for (const extension of ['png', 'jpeg', 'jpg', 'webp']) {
    assert.equal((await put(http, `inputs/uploads/bad.${extension}`, samples.md)).statusCode, 400);
    const info = uploadInfo(`inputs/uploads/big.${extension}`);
    assert.equal((await put(http, `inputs/uploads/big.${extension}`, Buffer.alloc(info.limit + 1))).statusCode, 413);
  }
  assert.equal((await put(http, 'inputs/uploads/wrong.png', samples.jpeg)).statusCode, 400);
  const forgedWebp = Buffer.from(samples.webp); forgedWebp[0] |= 0x80;
  assert.equal((await put(http, 'inputs/uploads/forged.webp', forgedWebp)).statusCode, 400);
  assert.equal((await put(http, 'inputs/uploads/a..md', samples.md)).statusCode, 201, '文件名内部的点不等于上级目录段');
  for (const extension of ['md', 'txt']) {
    assert.equal((await put(http, `inputs/uploads/invalid.${extension}`, Buffer.from([0xc3, 0x28]))).statusCode, 400);
    assert.equal((await put(http, `inputs/uploads/big.${extension}`, Buffer.alloc(256 * 1024 + 1))).statusCode, 413);
    assert.equal((await put(http, `inputs/uploads/exact.${extension}`, Buffer.alloc(256 * 1024, 65))).statusCode, 201);
  }
  const maxImage = Buffer.alloc(5 * 1024 * 1024); samples.png.copy(maxImage);
  assert.equal((await put(http, 'inputs/uploads/exact.png', maxImage)).statusCode, 201);
  assert.equal((await put(http, 'inputs/uploads/same.png', samples.png)).statusCode, 201);
  const duplicate = await put(http, 'inputs/uploads/same.png', samples.png);
  assert.equal(duplicate.statusCode, 409); assert.match(duplicate.body.error.message, /换名/);
});
test('上传：认证、来源、门禁、限流及跨用户隔离', async t => {
  const { http, files, gate, agent } = setup(t), locator = 'inputs/uploads/private.png';
  assert.equal((await put(http, locator, samples.png, { token: '' })).statusCode, 401);
  assert.equal((await put(http, locator, samples.png, { origin: 'https://evil.example.com' })).statusCode, 403);
  assert.equal((await put(http, locator, samples.png)).statusCode, 201);
  runOwner(OWNER_B, () => assert.throws(() => files.read_upload({ path: locator }), /资源不存在/));
  assert.equal((await put(http, locator, samples.png, { token: 'bob' })).statusCode, 201, '同名文件落在各自目录');
  await runOwner(OWNER_A, async () => {
    gate.start({ id: 'task', threadId: 'thread', userId: OWNER_A }); gate.started('thread', 'turn');
    await assert.rejects(gate.run(gate.forTurn('thread', 'turn'), () => gate.check('upload', { path: locator })), { status: 403 });
    gate.end('thread');
  });
  agent.sources = [];
  assert.equal((await put(http, 'inputs/uploads/denied.png', samples.png)).statusCode, 403);
  const limited = setup(t, { rateLimit: 1 });
  assert.equal((await put(limited.http, locator, samples.png)).statusCode, 201);
  assert.equal((await put(limited.http, 'inputs/uploads/second.png', samples.png)).statusCode, 429);
});
test('上传：符号链接、硬链接、目录不可作为附件或覆盖目标', async t => {
  const { http, files } = setup(t);
  await put(http, 'inputs/uploads/original.png', samples.png);
  runOwner(OWNER_A, () => {
    const base = path.join(files.workspace, 'inputs/uploads');
    fs.symlinkSync(path.join(base, 'original.png'), path.join(base, 'link.png'));
    fs.linkSync(path.join(base, 'original.png'), path.join(base, 'hard.png'));
    fs.mkdirSync(path.join(base, 'directory.png'));
    for (const name of ['link.png', 'hard.png', 'directory.png']) assert.throws(() => files.read_upload({ path: `inputs/uploads/${name}` }));
  });
});
test('分片转发：上传按类型限制原始字节，普通请求仍限制 512 KiB', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  assert.equal((await bufferBody(Readable.from([bytes]), uploadInfo('inputs/uploads/x.png').limit)).length, bytes.length);
  await assert.rejects(bufferBody(Readable.from([Buffer.alloc(bytes.length + 1)]), bytes.length), { status: 413 });
  await assert.rejects(bufferBody(Readable.from([Buffer.alloc(512 * 1024 + 1)])), { status: 413 });
});
