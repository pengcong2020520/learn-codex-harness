import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { bm25, fuse, tokenize, chunks, Embeddings } from '../server/modules/knowledge/rag.mjs';
const agent = { assertCurrent() {}, allowsTool: n => ['read_file','kb_read'].includes(n), sources: [{ locator: 'inputs', actions: ['read'] }, { locator: 'research', actions: ['read','create'] }], outputs: { directory: 'outputs' },
  definition: { agent: { id: 'a', knowledge: [{ kbId: 'private', actions: ['read','update'] }] }, bindings: { knowledgeBases: {
    private: { sourceRoot: 'inputs/private', wikiRoot: 'research/private/wiki' }, foreign: { sourceRoot: 'inputs/foreign', wikiRoot: 'research/foreign/wiki' }
  } } } };
test('统一门禁：伪造身份、未挂载 KB、普通任务更新、普通文件绕 Wiki 均拒绝', async () => {
  const gate = new PermissionGate({ scope: { ownerId: 'owner' }, agent });
  await assert.rejects(gate.run({ ownerId: 'owner' }, () => gate.current()), /未授权/);
  gate.start({ id: 'one', threadId: 't' }); gate.started('t','v1'); const ctx = gate.forTurn('t','v1');
  await gate.run(ctx, async () => {
    assert.throws(() => gate.check('tool.call', { name: 'shell' }), /未授权/);
    assert.throws(() => gate.check('read', { path: 'inputs/foreign/secret.md' }), /未授权/);
    assert.throws(() => gate.check('read', { kbId: 'private', ownerId: 'other' }), /未授权/);
    assert.throws(() => gate.check('update', { kbId: 'private' }), /未授权/);
    assert.throws(() => gate.check('create', { path: 'research/private/wiki/page.md' }), /未授权/);
    gate.check('read', { kbId: 'private' });
  });
  gate.end('t','v1'); gate.start({ id: 'two', threadId: 't' }, [{ type: 'knowledge.update', kbId: 'other' }]); gate.started('t','v2');
  await assert.rejects(gate.run(gate.forTurn('t','v2'), async () => gate.check('update', { kbId: 'private' })), /未授权/, '授权只覆盖它点名的知识库');
  gate.end('t','v2'); gate.start({ id: 'three', threadId: 't' }, [{ type: 'knowledge.update', kbId: 'private' }]); gate.started('t','v2');
  await assert.rejects(gate.run(ctx, () => gate.check('read', { kbId: 'private' })), /已结束|未授权/);
  assert.throws(() => gate.forTurn('t','v1'), /未授权/);
  await gate.run(gate.forTurn('t','v2'), () => gate.check('update', { kbId: 'private' }));
  await gate.run(gate.user(), async () => {
    assert.deepEqual(gate.authorize([{ type: 'knowledge.update', kbId: 'private' }]), [{ type: 'knowledge.update', kbId: 'private' }]);
    assert.throws(() => gate.authorize([{ type: 'knowledge.update', kbId: 'foreign' }]), /未授权/, '未挂载的知识库不能授权');
    assert.throws(() => gate.authorize([{ type: 'files.delete', path: 'inputs' }]), /未授权/, '未知授权类型一律拒绝');
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(gate.run(gate.forTurn('t','v2'), () => gate.current(), controller.signal));
});
test('中文 BM25 与 RRF：精确词命中、跨召回重合加权、分块 ID 绑定来源版本', () => {
  const docs = chunks([{ resourceId:'one',versionId:'v1',content:'门店经营和现金流管理' }, { resourceId:'two',versionId:'v2',content:'火星探测与航天技术' }]);
  assert.ok(tokenize('现金流管理').length > 1);
  assert.equal(bm25(docs,'火星探测')[0],docs[1].id);
  assert.equal(fuse(['a','b'],['b','c'])[0].id,'b');
  assert.notEqual(chunks([{resourceId:'one',versionId:'v2',content:'门店经营和现金流管理'}])[0].id, docs[0].id);
  assert.throws(() => new Embeddings({url:'http://untrusted.example',model:'m',dimensions:3}),/HTTPS/);
});
