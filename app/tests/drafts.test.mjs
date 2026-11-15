import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFileTools } from '../server/modules/data/files.mjs';
import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { tempRoot } from './helpers.mjs';

function fixture(t) {
  const root = tempRoot(t), workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, 'inputs'), { recursive: true });
  const options = { workspaceDir, sources: [{ id: 'inputs', locator: 'inputs', actions: ['read', 'create'] }] };
  const files = createFileTools(root, options);
  const write = (name, text) => files.write_draft({ name, content: Buffer.from(text) });
  return { root, workspaceDir, options, files, write };
}

test('草稿：覆盖原子替换、并发串行、JSON/Markdown 可通过现有工具读取且 Agent 不可写', async t => {
  const f = fixture(t);
  f.write('brief.json', '{"version":0}');
  await Promise.all(Array.from({ length: 30 }, (_, i) => Promise.resolve().then(() => {
    const inode = fs.statSync(path.join(f.workspaceDir, 'inputs/drafts/brief.json')).ino;
    f.write('brief.json', JSON.stringify({ version: i + 1 }));
    assert.notEqual(fs.statSync(path.join(f.workspaceDir, 'inputs/drafts/brief.json')).ino, inode);
  })));
  assert.equal(f.files.read_draft({ name: 'brief.json' }).content, '{"version":30}');
  assert.equal(f.files.read_file({ path: 'inputs/drafts/brief.json' }).content, '{"version":30}');
  assert.deepEqual(fs.readdirSync(path.join(f.workspaceDir, 'inputs/drafts')), ['brief.json']);
  f.write('notes.md', '# 意见');
  assert.throws(() => f.files.write_file({ path: 'inputs/drafts/new.md', content: '绕过' }), /未授权/);
  assert.throws(() => f.files.check('inputs/drafts/new.md', 'create'), /未授权/);
  assert.equal(f.files.read_draft({ name: 'notes.md' }).content, '# 意见');
});

test('草稿：名称、路径、大小、数量、非法 JSON 与 UTF-8 边界', t => {
  const f = fixture(t);
  for (const name of ['../brief.json', '/brief.json', 'x/brief.json', '..\\brief.json', 'A.json', '.json', 'a'.repeat(65) + '.md', 'a.txt', 'a.md/..', 'a.json\0', 'a.md\n']) {
    assert.throws(() => f.write(name, '{}'), { status: 400 });
    assert.throws(() => f.files.read_draft({ name }), { status: 400 });
  }
  assert.throws(() => f.write('brief.json', '{'), { status: 400 });
  assert.throws(() => f.files.write_draft({ name: 'brief.md', content: Buffer.from([0xff]) }), { status: 400 });
  f.write('a'.repeat(64) + '.md', 'a'.repeat(256 * 1024));
  assert.throws(() => f.write('large.md', 'a'.repeat(256 * 1024 + 1)), { status: 413 });
  for (let i = 0; i < 199; i++) f.write(`draft-${i}.json`, 'null');
  assert.throws(() => f.write('overflow.md', 'a'), { status: 409 });
  f.write('draft-0.json', '[1]');
  assert.equal(f.files.read_draft({ name: 'draft-0.json' }).content, '[1]');
});

test('草稿：拒绝目录、符号链接、硬链接；写失败保留旧正文且清理临时文件', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside.md');
  fs.writeFileSync(outside, '外部');
  f.write('safe.md', '原文');
  const dir = path.join(f.workspaceDir, 'inputs/drafts');
  fs.symlinkSync(outside, path.join(dir, 'link.md'));
  fs.linkSync(outside, path.join(dir, 'hard.md'));
  fs.mkdirSync(path.join(dir, 'directory.md'));
  for (const name of ['link.md', 'hard.md', 'directory.md']) {
    assert.throws(() => f.write(name, '改'));
    assert.throws(() => f.files.read_draft({ name }));
  }
  t.mock.method(fs, 'renameSync', () => { throw new Error('模拟替换失败'); });
  assert.throws(() => f.write('safe.md', '新文'), /模拟替换失败/);
  assert.equal(f.files.read_draft({ name: 'safe.md' }).content, '原文');
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.draft-')), false);
  const nested = fixture(t);
  fs.symlinkSync(dir, path.join(nested.workspaceDir, 'inputs/drafts'));
  assert.throws(() => nested.write('safe.md', '改'), /符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '外部');
});

test('草稿：按服务端身份隔离同名文件，不允许跨用户路径', async t => {
  const f = fixture(t), files = createUserFileTools(f.root, f.options);
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  await runOwner(a, () => files.write_draft({ name: 'brief.json', content: Buffer.from('{"owner":"a"}') }));
  await runOwner(b, () => {
    assert.throws(() => files.read_draft({ name: 'brief.json' }), { status: 404 });
    files.write_draft({ name: 'brief.json', content: Buffer.from('{"owner":"b"}') });
    assert.throws(() => files.read_draft({ name: `../../../${a}/inputs/drafts/brief.json` }), { status: 400 });
  });
  await runOwner(a, () => assert.equal(files.read_draft({ name: 'brief.json' }).content, '{"owner":"a"}'));
});

test('草稿 HTTP：认证、来源、正文类型、大小与跨用户隔离沿用入口门禁', async t => {
  const { accountFixture, httpFixture, request, Response } = await import('./accounts-fixture.mjs');
  const { Readable } = await import('node:stream');
  const f = fixture(t), files = createUserFileTools(f.root, f.options), { accounts } = await accountFixture();
  const http = httpFixture(accounts, { files }); t.after(() => http.close());
  const alice = (await accounts.login({ username: 'alice', password: 'fixture-password' }, 'fixture')).token;
  const bob = (await accounts.login({ username: 'bob', password: 'fixture-password' }, 'fixture')).token;
  assert.equal((await request(http, '/workspace/drafts?name=brief.json')).statusCode, 401);
  const saved = await request(http, '/workspace/drafts?name=brief.json', { token: alice, method: 'PUT', body: { version: 1 } });
  assert.equal(saved.statusCode, 200);
  assert.equal((await request(http, '/workspace/drafts?name=brief.json', { token: alice })).body.content, '{"version":1}');
  assert.equal((await request(http, '/workspace/drafts?name=brief.json', { token: bob })).statusCode, 404);
  assert.equal((await request(http, '/workspace/drafts?name=brief.json', { token: alice, method: 'PUT', body: {}, headers: { origin: 'https://evil.example.com' } })).statusCode, 403);
  for (const [name, content, type, status] of [['brief.json', '{', 'application/json', 400], ['brief.json', '{}', 'text/plain', 415], ['brief.md', '# 草稿', 'text/markdown', 200], ['large.md', 'x'.repeat(256 * 1024 + 1), 'text/markdown', 413], ['../a.json', '{}', 'application/json', 400]]) {
    const response = new Response(), req = Readable.from([Buffer.from(content)]);
    Object.assign(req, { method: 'PUT', url: `/workspace/drafts?name=${encodeURIComponent(name)}`, headers: { authorization: `Bearer ${alice}`, 'content-type': type }, socket: { remoteAddress: 'peer' } });
    await http.handle(req, response); assert.equal(response.statusCode, status);
  }
});


test('草稿：目录存在时读取缺失草稿也返回明确的 404', t => {
  const { files, write } = fixture(t);
  write('present.json', '{}');
  assert.throws(() => files.read_draft({ name: 'missing.json' }), { status: 404, message: '草稿不存在。' });
});
