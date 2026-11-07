import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadModelRegistry, buildGatewayConfig, buildModelParameters, validateRegistry } from '../server/modules/gateway/index.mjs';
import { createModelRouter } from '../server/modules/gateway/router.mjs';
import { createToolService } from '../server/modules/tools/loader.mjs';
import { Resources } from '../server/modules/data/resources.mjs';
import { UsageService } from '../server/modules/usage/index.mjs';
import { setup, registry, png, mp4, mediaScenarios } from './media-fixture.mjs';

const transport = async (_t, handler) => ({ fetchImpl: async (url, init) => {
  const result = await handler({ url: new URL(url).pathname, method: init.method, authorization: init.headers.Authorization,
    body: init.body ? JSON.parse(init.body) : undefined });
  return new Response(Buffer.isBuffer(result) ? result : JSON.stringify(result));
} });
mediaScenarios(test, transport);

test('byteplus 内置服务商、模型用途、候选顺序、base_url 和未定价', () => {
  const r = loadModelRegistry(path.resolve(import.meta.dirname, '..'));
  const environment = { ARK_API_KEY: 'test-provider-key' };
  const config = buildGatewayConfig(r, environment), provider = config.providers.byteplus;
  assert.equal(provider.custom_provider_config, undefined);
  assert.equal(provider.network_config.base_url, 'https://ark.cn-beijing.volces.com');
  assert.equal(provider.keys[0].value, 'env.ARK_API_KEY'); assert.equal(provider.keys[0].models.length, 4);
  const router = createModelRouter(r, environment);
  assert.equal(router.resolve({ purpose: 'image' }).id, 'byteplus/doubao-seedream-5-0-flash-260915');
  assert.equal(router.resolve({ purpose: 'video' }).id, 'byteplus/doubao-seedance-2-0-mini-260615');
  const parameters = buildModelParameters(r, environment);
  for (const purpose of ['image','video']) for (const id of r.routes[purpose]) {
    assert.equal(parameters[id].mode, purpose); assert.equal(r.models[id].pricing, undefined);
  }
  r.providers.alias = { type: 'byteplus', keyEnv: 'ALIAS_API_KEY' };
  assert.throws(() => validateRegistry(r), /名称必须是 byteplus/);
});

test('媒体 pricing：张/秒与 token 累加，未定价标记未计价，零价、去重与非法价格', async () => {
  for (const field of ['perImage','perVideoSecond']) for (const invalid of [-1, Infinity, NaN, null, '1']) {
    const r = structuredClone(registry); r.models['byteplus/image'].pricing[field] = invalid;
    assert.throws(() => validateRegistry(r), new RegExp(`pricing.${field}`));
  }
  const r = structuredClone(registry); r.models['byteplus/video'].pricing = { perVideoSecond: 0 };
  validateRegistry(r);
  const usage = new UsageService({ registry: r });
  await usage.record({ source: 'video', model: 'byteplus/video', units: 5, eventKey: 'same-event' });
  await usage.record({ source: 'video', model: 'byteplus/video', units: 5, eventKey: 'same-event' });
  assert.equal(usage.rows.length, 1); assert.equal(usage.rows[0].estimatedCost, 0);
  delete r.models['byteplus/image'].pricing;
  await usage.record({ source: 'image', model: 'byteplus/image', units: 1 });
  assert.equal(usage.rows[1].estimatedCost, null);
  r.models['byteplus/image'].pricing = { perImage: 0.2 };
  await usage.record({ source: 'image', model: 'byteplus/image', units: 2, inputTokens: 100, outputTokens: 100 });
  assert.equal(usage.rows[2].estimatedCost, 0.4);
});

test('二进制 create-only、格式/目录、正文签名、链接与不可变 blob', t => {
  const r = setup(t);
  const output = r.local.write_binary({ path: 'outputs/media/test.png', content: png });
  assert.equal(output.bytes, png.length);
  assert.equal(output.artifact.revision, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(r.local.read_binary({ path: output.path }).content, png);
  assert.throws(() => r.local.write_binary({ path: output.path, content: png }), /已存在/);
  assert.throws(() => r.local.write_binary({ path: 'research/test.png', content: png }), /outputs/);
  assert.throws(() => r.local.write_binary({ path: 'outputs/test.jpeg', content: png }), /扩展名/);
  assert.throws(() => r.local.write_binary({ path: 'outputs/../test.png', content: png }), /上级目录/);
  assert.throws(() => r.local.write_file({ path: 'outputs/text.png', content: 'text' }), /只支持/);
  fs.symlinkSync(path.join(r.local.workspace,'research'), path.join(r.local.workspace,'outputs/link'));
  assert.throws(() => r.local.write_binary({ path: 'outputs/link/test.png', content: png }), /符号链接/);
  const resources = new Resources(null, {}, { files: r.local, sources: r.agent.sources, outputs: r.agent.outputs, blobDir: path.join(r.root,'blobs'), gate: r.gate });
  const blob = resources.blob(mp4), again = resources.blob(mp4);
  assert.deepEqual(blob, again); assert.match(blob.blob, /\.bin$/);
  assert.deepEqual(fs.readFileSync(path.join(r.root, 'blobs', blob.blob)), mp4);
  assert.throws(() => resources.check_binary('outputs/test.mp4'), /未授权/);
});

test('没有可用模型时目录和调用都不可用；参数有长度、数量、秒数边界', async t => {
  const r = setup(t);
  r.service.router = createModelRouter(registry, {});
  let tools = await createToolService(r.root, { files: r.files, media: r.service, agent: r.agent });
  assert.deepEqual(tools.specs, []);
  assert.throws(() => tools.validate('generate_image', { prompt: 'test' }), /未授权/);
  r.service.router = r.router;
  tools = await createToolService(r.root, { files: r.files, media: r.service, agent: r.agent });
  assert.equal(tools.specs.length, 3);
  for (const args of [{ prompt: '' }, { prompt: ' ' }, { prompt: 'a'.repeat(8001) }, { prompt: 'test', n: 0 }, { prompt: 'test', n: 5 }])
    assert.throws(() => tools.validate('generate_image', args), /参数不合法/);
  for (const seconds of [1, 16, 2.5]) assert.throws(() => tools.validate('generate_video', { prompt: 'test', seconds }), /参数不合法/);
  r.service.router = createModelRouter({ ...registry, routes: { image: registry.routes.image } }, { ARK_API_KEY: 'test-only' });
  tools = await createToolService(r.root, { files: r.files, media: r.service, agent: r.agent });
  assert.deepEqual(tools.specs.map(s => s.name), ['generate_image']);
});

test('后台路径授权限于单个产物；撤销工具后不下载或写入', async t => {
  let calls = 0;
  const r = setup(t, await transport(t, () => { calls++; return { id: 'remote-id' }; }));
  const submitted = await r.call('generateVideo', { prompt: 'test' });
  const job = await r.store.get(submitted.id), context = r.gate.media(job);
  await assert.rejects(r.gate.run(context, async () => r.gate.check('create', { path: 'outputs/other.mp4' })), /未授权/);
  r.agent.definition.agent.tools.allow = [];
  await r.service.tick(); assert.equal((await r.service.status(submitted)).status, 'failed'); assert.equal(calls, 1);
});

test('提交中定时器不误判重启；不确定提交在重启后失败且不重提', async t => {
  let release, posted;
  const r = setup(t, await transport(t, async request => { if (request.method !== 'POST') return { status: 'queued' }; posted = true; await new Promise(resolve => { release = resolve; }); return { id: 'remote' }; }));
  const pending = r.call('generateVideo', { prompt: 'test' });
  while (!posted) await new Promise(resolve => setImmediate(resolve));
  await r.service.tick(); assert.equal((await r.store.pending())[0].status, 'submitting');
  release(); await pending;
  const job = { id: randomUUID(), status: 'submitting', agentId: 'media-test', context: {}, path: 'outputs/pending.mp4' };
  await r.store.save(job); await r.service.tick();
  assert.match((await r.service.status(job)).error, /不会|不自动重提/);
});

test('服务商返回模型未开通时，提示去控制台开通，不转出错误原文', async t => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: 'ModelNotOpen', message: 'Your account 1234567890 has not activated the model' } }), { status: 404 });
  const r = setup(t, { fetchImpl });
  await assert.rejects(r.call('generateImage', { prompt: 'test' }), error => /HTTP 404.*模型还没有在服务商控制台开通/.test(error.message) && !/1234567890/.test(error.message));
  const other = setup(t, { fetchImpl: async () => new Response('not json', { status: 502 }) });
  await assert.rejects(other.call('generateImage', { prompt: 'test' }), /媒体网关请求失败（HTTP 502）。/);
});
