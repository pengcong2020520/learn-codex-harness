// 真 Bifrost 的 byteplus 通道 + 本机模拟火山方舟；不读取 .env，不调用真实模型。
// 需要 Docker 和本机端口（npm run test:gateway）；没有 Docker 时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildGatewayConfig, buildModelParameters, loadModelRegistry } from '../server/modules/gateway/index.mjs';
import { createModelRouter } from '../server/modules/gateway/router.mjs';
import { UsageService } from '../server/modules/usage/index.mjs';
import { setup, png, mp4 } from './media-fixture.mjs';
import { until } from './helpers.mjs';

const app = path.resolve(import.meta.dirname, '..');
const image = fs.readFileSync(path.join(app, 'compose.yaml'), 'utf8').match(/^\s+image: (maximhq\/bifrost:\S+)$/m)[1];
const docker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

test('模型网关：生图、生视频经 byteplus 通道转换为火山方舟格式，后台保存并记账', { skip: !docker && '需要 Docker', timeout: 120000 }, async t => {
  const registry = loadModelRegistry(app);
  const gatewayKey = `sk-bf-test-${randomBytes(8).toString('hex')}`;
  const environment = { AGENT_GATEWAY_KEY: gatewayKey, ARK_API_KEY: 'sk-ark-test-only' };
  const router = createModelRouter(registry, environment);
  const imageModel = 'doubao-seedream-5-0-flash-260915', videoModel = 'doubao-seedance-2-0-mini-260615';
  assert.equal(router.resolve({ purpose: 'image' }).id, `byteplus/${imageModel}`);
  assert.equal(router.resolve({ purpose: 'video' }).id, `byteplus/${videoModel}`);
  const requests = [], states = [], taskId = 'cgt-media-test';
  const imageRoute = '/api/v3/images/generations', videoRoute = '/api/v3/contents/generations/tasks';
  const fileRoute = '/media/test.mp4';
  let upstreamUrl;
  const server = http.createServer(async (request, response) => {
    const json = body => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    // 启动探测不一定有请求体；未知路径先回 404，不把探测当生成请求。
    const known = request.method === 'POST' && [imageRoute, videoRoute].includes(request.url)
      || request.method === 'GET' && [videoRoute + '/' + taskId, fileRoute].includes(request.url);
    if (!known) { response.writeHead(404); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body = null;
    try { if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { response.writeHead(400); response.end(); return; }
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    if (request.method === 'POST' && !body) { response.writeHead(400); response.end(); return; }
    if (request.url === imageRoute) {
      json({ model: imageModel, created: Math.floor(Date.now() / 1000), data: [{ b64_json: png.toString('base64'), size: '2048x2048' }],
        usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384 } });
    } else if (request.url === videoRoute) {
      json({ id: taskId });
    } else if (request.url === fileRoute) {
      response.writeHead(200, { 'content-type': 'video/mp4' }); response.end(mp4);
    } else {
      const status = ['queued', 'running'][states.length] || 'succeeded';
      states.push(status);
      json({ id: taskId, model: videoModel, status, created_at: 1700000000, updated_at: 1700000001,
        duration: 5, resolution: '720p', ratio: '16:9',
        ...(status === 'succeeded' ? { content: { video_url: upstreamUrl + fileRoute }, usage: { completion_tokens: 100, total_tokens: 100 } } : {}) });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  upstreamUrl = `http://host.docker.internal:${server.address().port}`;

  // 正式清单与配置生成函数保持不变，只把 byteplus 的网络地址换为模拟服务。
  const config = buildGatewayConfig(registry, environment);
  assert.deepEqual(Object.keys(config.providers), ['byteplus']);
  assert.equal(config.providers.byteplus.custom_provider_config, undefined, '使用内置 byteplus 通道');
  config.providers.byteplus.network_config = { base_url: upstreamUrl, allow_private_network: true, max_retries: 0 };
  // 与已有网关测试一致：放在项目 .runs 下，便于 Colima 挂载。
  fs.mkdirSync(path.join(app, '.runs'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(app, '.runs', 'media-gateway-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'model-parameters.json'), JSON.stringify(buildModelParameters(registry, environment)), { mode: 0o644 });
  const name = `codex-harness-media-test-${randomBytes(4).toString('hex')}`;
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '--add-host', 'host.docker.internal:host-gateway',
    '-e', `AGENT_GATEWAY_KEY=${gatewayKey}`, '-e', `ARK_API_KEY=${environment.ARK_API_KEY}`,
    '--tmpfs', '/app/data:uid=1000,gid=0,mode=0770', '-v', `${path.join(dir, 'config.json')}:/app/data/config.json:ro`,
    '-v', `${path.join(dir, 'model-parameters.json')}:/app/data/model-parameters.json:ro`,
    '-p', '127.0.0.1::8080', image], { stdio: 'ignore' });
  t.after(() => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }));
  const port = Number(execFileSync('docker', ['port', name, '8080/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)) break;
    if (i === 59) assert.fail(`网关没有就绪：${execFileSync('docker', ['logs', name], { encoding: 'utf8' }).slice(-800)}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const usage = new UsageService({ registry });
  const r = setup(t, { router, usage, endpoint: { baseUrl: `${base}/v1`, apiKey: gatewayKey }, fetchImpl: fetch, intervalMs: 25 });
  const imagePrompt = '一只在窗边晒太阳的猫', videoPrompt = '镜头缓缓掠过海边日落';
  const picture = await r.call('generateImage', { prompt: imagePrompt, path: 'outputs/media/ark.png' });
  assert.deepEqual(picture.paths, ['outputs/media/ark.png']);
  const savedImage = fs.readFileSync(path.join(r.local.workspace, picture.paths[0]));
  assert.equal(savedImage.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(savedImage, png);
  assert.deepEqual(usage.rows.map(({ source, model, units }) => ({ source, model, units })),
    [{ source: 'image', model: `byteplus/${imageModel}`, units: 1 }]);

  const video = await r.call('generateVideo', { prompt: videoPrompt, seconds: 5, size: '1280x720', path: 'outputs/media/ark.mp4' });
  assert.ok(video.id); assert.ok(video.providerId); assert.equal(video.status, 'queued');
  assert.equal(states.length, 0, '提交即返回任务 ID，不等待生成或查询');
  assert.equal(fs.existsSync(path.join(r.local.workspace, 'outputs/media/ark.mp4')), false);
  r.gate.end('thread', 'turn');
  r.service.open();
  await until(async () => ['completed', 'failed'].includes((await r.service.status(video)).status), 30000);
  const status = await r.service.status(video);
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.equal(status.path, 'outputs/media/ark.mp4');
  const savedVideo = fs.readFileSync(path.join(r.local.workspace, status.path));
  assert.equal(savedVideo.subarray(4, 8).toString(), 'ftyp');
  assert.deepEqual(savedVideo, mp4);
  await r.service.tick();
  assert.deepEqual(usage.rows.map(({ source, model, units }) => ({ source, model, units })),
    [{ source: 'image', model: `byteplus/${imageModel}`, units: 1 }, { source: 'video', model: `byteplus/${videoModel}`, units: 5 }]);

  const images = requests.filter(request => request.path === imageRoute);
  assert.equal(images.length, 1); assert.equal(images[0].method, 'POST');
  assert.equal(images[0].body.model, imageModel); assert.equal(images[0].body.prompt, imagePrompt);
  assert.equal(images[0].body.response_format, 'b64_json'); assert.equal(images[0].body.size, '2048x2048');
  const videos = requests.filter(request => request.path === videoRoute);
  assert.equal(videos.length, 1); assert.equal(videos[0].method, 'POST');
  assert.equal(videos[0].body.model, videoModel); assert.equal(videos[0].body.duration, 5);
  assert.deepEqual(videos[0].body.content, [{ type: 'text', text: videoPrompt }]);
  assert.equal(videos[0].body.resolution, '720p'); assert.equal(videos[0].body.ratio, '16:9');
  assert.deepEqual(states.slice(0, 3), ['queued', 'running', 'succeeded']);
  assert.ok(states.length >= 4, '下载时网关还会查询一次任务');
  assert.ok(requests.some(request => request.method === 'GET' && request.path === fileRoute), '网关从 video_url 拉取 MP4');
  for (const request of requests.filter(request => request.path !== fileRoute))
    assert.equal(request.authorization, `Bearer ${environment.ARK_API_KEY}`, '上游收到方舟假密钥，而非网关访问密钥');
});
