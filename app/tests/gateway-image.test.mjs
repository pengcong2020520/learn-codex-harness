import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { checkGateway, main, TEST_IMAGE } from '../scripts/gateway-check.mjs';
const environment = { AGENT_GATEWAY_KEY: 'sk-bf-fixture-gateway', SAMPLE_API_KEY: 'fixture-provider' };
const registry = { providers: { sample: { type: 'openai', keyEnv: 'SAMPLE_API_KEY' } }, models: { 'sample/chat': { purposes: ['chat'] } } };
function mockGateway(answer = '红色') {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    const image = body.input[0].content.some(part => part.type === 'input_image');
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: image ? answer : 'OK' }] }], usage: { input_tokens: 3, output_tokens: 1 } }));
  } };
}
test('gateway --image：指定模型经 Responses 发内置红图，中文红字判定；默认不测', async () => {
  const mock = mockGateway();
  const normal = await checkGateway({ environment, registry, ...mock });
  assert.equal(normal.rows[0].image, null); assert.equal(mock.calls.length, 1);
  const report = await checkGateway({ environment, registry, model: 'sample/chat', image: true, ...mock });
  assert.equal(report.exitCode, 0); assert.equal(report.rows[0].image, true); assert.equal(report.rows[0].inputTokens, 6);
  const call = mock.calls.at(-1);
  assert.equal(call.url, 'http://127.0.0.1:4330/v1/responses');
  assert.equal(call.options.headers.Authorization, 'Bearer sk-bf-fixture-gateway');
  assert.equal(call.body.model, 'sample/chat');
  assert.deepEqual(call.body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '这张图片是什么颜色' }, { type: 'input_image', image_url: TEST_IMAGE }] }]);
  assert.equal(call.body.tools, undefined);
  const png = Buffer.from(TEST_IMAGE.split(',')[1], 'base64');
  assert.equal(png.readUInt32BE(16), 8); assert.equal(png.readUInt32BE(20), 8);
  const length = png.readUInt32BE(33), pixels = inflateSync(png.subarray(41, 41 + length));
  assert.deepEqual(pixels, Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill([255, 0, 0]).flat()]))));
});
test('gateway --image：无红字失败；必须显式给模型；参数与费用提示可离线验证', async () => {
  for (const answer of ['蓝色', 'red', '']) {
    const mock = mockGateway(answer), lines = [];
    assert.equal(await main(['--model', 'sample/chat', '--image'], { environment, registry, ...mock, log: line => lines.push(line) }), 1);
    assert.equal(mock.calls.length, 2); assert.match(lines.join('\n'), /看图失败/); assert.match(lines.join('\n'), /产生费用/);
    assert.doesNotMatch(lines.join('\n'), /sk-bf-fixture-gateway|fixture-provider/);
  }
  const mock = mockGateway(), lines = [];
  assert.equal(await main(['--image'], { environment, registry, ...mock, log: line => lines.push(line) }), 1);
  assert.equal(mock.calls.length, 0); assert.match(lines.join('\n'), /必须同时指定 --model/);
  assert.equal(await main(['--image', '--model', 'sample/chat'], { environment, registry, ...mock, log() {} }), 0);
});
