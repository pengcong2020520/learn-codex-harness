import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MediaService } from '../server/modules/media/index.mjs';
import { createFileTools } from '../server/modules/data/files.mjs';
import { UsageService } from '../server/modules/usage/index.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { createModelRouter } from '../server/modules/gateway/router.mjs';
import { createToolService } from '../server/modules/tools/loader.mjs';
import { installToolFixture, tempRoot, until } from './helpers.mjs';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
export const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
export const registry = {
  schemaVersion: 1, providers: { byteplus: { type: 'byteplus', keyEnv: 'ARK_API_KEY' } },
  models: { 'byteplus/image': { purposes: ['image'], pricing: { input: 2, output: 4, perImage: 0.25 } },
    'byteplus/video': { purposes: ['video'], pricing: { perVideoSecond: 0.1 } } },
  routes: { image: ['byteplus/image'], video: ['byteplus/video'] },
};
export class MemoryMediaJobs {
  constructor() { this.rows = new Map(); }
  async save(job) { this.rows.set(job.id, structuredClone(job)); }
  async get(id) { return structuredClone(this.rows.get(id)); }
  async pending() { return [...this.rows.values()].filter(job => !['completed','failed'].includes(job.status)).map(job => structuredClone(job)); }
}
export function setup(t, transport = {}) {
  const root = installToolFixture(tempRoot(t)), store = new MemoryMediaJobs();
  const outputs = { directory: 'outputs', formats: ['md','txt','png','jpeg','webp','mp4'] };
  const sources = ['research','outputs'].map(locator => ({ locator, id: locator, actions: ['read','create'] }));
  const agent = { outputs, sources, definition: { agent: { id: 'media-test', tools: { allow: ['generate_image','generate_video','media_status'] } }, bindings: {} },
    allowsTool: name => agent.definition.agent.tools.allow.includes(name), assertCurrent() {}, revocation: new AbortController() };
  const gate = new PermissionGate({ scope: { ownerId: 'test-owner' }, agent });
  const local = createFileTools(root, { outputs, sources });
  const files = { workspace: local.workspace, check_binary: locator => local.check_binary(locator),
    write_binary: args => { gate.check('create', { path: args.path }); return local.write_binary(args); } };
  const usage = new UsageService({ registry });
  const router = createModelRouter(registry, { ARK_API_KEY: 'test-provider-key' });
  const options = { router, endpoint: { baseUrl: 'http://gateway.invalid/v1', apiKey: 'sk-bf-test-only' }, store, files, usage, gate, agent, ...transport };
  const service = new MediaService(options);
  t.after(() => service.close());
  gate.start({ id: 'task', threadId: 'thread' }); gate.started('thread','turn');
  const context = gate.forTurn('thread','turn');
  const call = (method, args) => gate.run(context, () => service[method](args, { context }));
  return { root, store, agent, gate, local, files, usage, router, options, service, context, call };
}

// 同一组行为既用本地 HTTP 网关验证协议，也可注入 Response 在禁止监听的沙箱中验证状态机。
export function mediaScenarios(test, transport) {
  test('生图：网关参数、b64_json、多图保存、张数与 token 记账、create-only', async t => {
    const requests = [];
    const network = await transport(t, request => {
      requests.push(request);
      return { data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
    });
    const r = setup(t, network);
    const tools = await createToolService(r.root, { files: r.files, media: r.service, gate: r.gate, agent: r.agent });
    const result = await tools.call({ tool: 'generate_image', arguments: { prompt: '测试图片', n: 2, path: 'outputs/media/picture.png' } }, { permissionContext: r.context });
    assert.equal(result.success, true, JSON.stringify(result));
    const output = JSON.parse(result.contentItems[0].text);
    assert.deepEqual(output.paths, ['outputs/media/picture-1.png','outputs/media/picture-2.png']);
    assert.equal(output.model, 'byteplus/image'); assert.equal(output.size, '2048x2048');
    assert.deepEqual(fs.readFileSync(path.join(r.local.workspace, output.paths[0])), png);
    assert.equal(requests[0].url, '/v1/images/generations');
    assert.equal(requests[0].authorization, 'Bearer sk-bf-test-only');
    assert.deepEqual(requests[0].body, { model: 'byteplus/image', prompt: '测试图片', n: 2, size: '2048x2048', response_format: 'b64_json' });
    const total = (await r.usage.summary()).total;
    assert.equal(total.units, 2); assert.equal(total.totalTokens, 12); assert.equal(total.estimatedCost, 0.500028);
    await assert.rejects(r.call('generateImage', { prompt: 'test', path: output.paths[0] }), /已存在/);
    assert.equal(requests.length, 1);
  });
  test('视频：立即返回、轮次结束后后台保存、media_status 与按秒记账', async t => {
    const requests = []; let polls = 0;
    const network = await transport(t, request => {
      requests.push(request);
      if (request.method === 'POST') return { id: 'remote-video' };
      if (request.url.endsWith('/content')) return mp4;
      return { status: ++polls === 1 ? 'in_progress' : 'completed' };
    });
    const r = setup(t, network);
    const output = await r.call('generateVideo', { prompt: '视频测试' });
    assert.equal(output.status, 'queued'); assert.equal(requests.length, 1); assert.equal(output.providerId, 'remote-video');
    assert.deepEqual(requests[0].body, { model: 'byteplus/video', prompt: '视频测试', seconds: '5', size: '1280x720' });
    r.gate.end('thread','turn');
    await r.service.tick(); assert.equal((await r.service.status(output)).status, 'in_progress');
    await r.service.tick();
    const status = await r.service.status(output);
    assert.equal(status.status, 'completed'); assert.match(status.path, /^outputs\/media\/.*\.mp4$/);
    assert.deepEqual(fs.readFileSync(path.join(r.local.workspace, status.path)), mp4);
    assert.equal((await r.usage.summary()).total.units, 5); assert.equal((await r.usage.summary()).total.estimatedCost, 0.5);
    await r.service.tick(); assert.equal((await r.usage.summary()).total.requests, 1);
    await assert.rejects(r.service.status({ id: '00000000-0000-0000-0000-000000000000' }), /不存在/);
  });
  test('视频失败与超时持久化原因，重启继续旧 ID，不重提', async t => {
    let posts = 0; let mode = 'queued';
    const network = await transport(t, request => {
      if (request.method === 'POST') return { id: `remote-${++posts}` };
      if (request.url.endsWith('/content')) return mp4;
      return { status: mode, error: { message: '测试失败原因' } };
    });
    const r = setup(t, network);
    const failed = await r.call('generateVideo', { prompt: 'test' });
    mode = 'failed'; await r.service.tick(); assert.match((await r.service.status(failed)).error, /测试失败原因/);
    const timeout = await r.call('generateVideo', { prompt: 'test' });
    const job = await r.store.get(timeout.id); job.deadline = Date.now() - 1; await r.store.save(job);
    await r.service.tick(); assert.match((await r.service.status(timeout)).error, /最长等待/);
    mode = 'queued'; const pending = await r.call('generateVideo', { prompt: 'test' });
    await r.service.tick(); await r.service.close();
    const resumed = new MediaService({ ...r.options, intervalMs: 5 }); t.after(() => resumed.close());
    mode = 'completed'; resumed.open();
    await until(async () => (await resumed.status(pending)).status === 'completed');
    assert.equal(posts, 3); assert.equal((await r.usage.summary()).total.requests, 1);
  });
  test('预算：生图、生视频被拒，查询状态不受限；目录、格式和门禁拒绝发生在收费请求前', async t => {
    let requests = 0;
    const network = await transport(t, () => { requests++; return {}; });
    const r = setup(t, network);
    r.usage.budget.dailyCost = 0;
    for (const [method, args] of [['generateImage',{ prompt: 'test' }],['generateVideo',{ prompt: 'test' }]])
      await assert.rejects(r.call(method,args), /预算已超/);
    // 查询不花钱：超预算时照常查询，不存在的任务报“不存在”，而不是“预算已超”。
    await assert.rejects(r.call('status',{ id: '00000000-0000-0000-0000-000000000000' }), /不存在/);
    r.usage.budget.dailyCost = null;
    await assert.rejects(r.call('generateImage',{ prompt: 'test', path: 'research/test.png' }), /outputs/);
    await assert.rejects(r.call('generateVideo',{ prompt: 'test', path: 'outputs/test.txt' }), /mp4/);
    r.agent.outputs.formats = ['md'];
    await assert.rejects(r.call('generateImage',{ prompt: 'test' }), /格式必须声明/);
    r.agent.outputs.formats = ['png'];
    r.gate.end('thread','turn');
    r.gate.start({ id: 'next', threadId: 'thread' }, [], ['drafts']); r.gate.started('thread','turn2');
    await assert.rejects(r.gate.run(r.gate.forTurn('thread','turn2'), () => r.service.generateImage({ prompt: 'test' })), /未授权/);
    assert.equal(requests, 0);
  });
}
