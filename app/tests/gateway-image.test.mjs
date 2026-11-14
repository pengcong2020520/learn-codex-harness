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
    const answers = image ? (Array.isArray(answer) ? answer : [[answer]]) : [['OK']];
    return new Response(JSON.stringify({ output: answers.map(parts => ({ type: 'message', content: parts.map(text => ({ type: 'output_text', text })) })), usage: { input_tokens: 3, output_tokens: 1 } }));
  } };
}
test('gateway --image：默认不测图片且不取随机数', async () => {
  const mock = mockGateway();
  const normal = await checkGateway({ environment, registry, ...mock, random: () => assert.fail('默认不应选择图片') });
  assert.equal(normal.rows[0].image, null); assert.equal(mock.calls.length, 1);
});
for (const [randomValue, color, rgb] of [[0, '红', [255, 0, 0]], [1 / 3, '绿', [0, 255, 0]], [2 / 3, '蓝', [0, 0, 255]], [0.999999, '蓝', [0, 0, 255]]]) {
  test(`gateway --image：随机源 ${randomValue} 选择 8×8 纯${color}图并显示颜色`, async () => {
    const mock = mockGateway(`${color}色`), lines = [];
    let draws = 0;
    const options = { environment, registry, ...mock, random: () => { draws++; return randomValue; } };
    const report = await checkGateway({ ...options, model: 'sample/chat', image: true });
    assert.equal(draws, 1);
    assert.equal(report.exitCode, 0); assert.equal(report.rows[0].image, true); assert.equal(report.rows[0].imageColor, color);
    assert.equal(report.rows[0].inputTokens, 6); assert.equal(report.rows[0].outputTokens, 2);
    assert.match(report.messages.join('\n'), /连续两次通过/);
    const call = mock.calls.at(-1), imageUrl = call.body.input[0].content[1].image_url;
    assert.equal(call.url, 'http://127.0.0.1:4330/v1/responses');
    assert.equal(call.options.headers.Authorization, 'Bearer sk-bf-fixture-gateway');
    assert.equal(call.body.model, 'sample/chat');
    assert.deepEqual(call.body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '这张图片是什么颜色' }, { type: 'input_image', image_url: imageUrl }] }]);
    assert.equal(call.body.tools, undefined);
    if (color === '红') assert.equal(imageUrl, TEST_IMAGE);
    const png = Buffer.from(imageUrl.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 8); assert.equal(png.readUInt32BE(20), 8);
    const length = png.readUInt32BE(33), pixels = inflateSync(png.subarray(41, 41 + length));
    assert.deepEqual(pixels, Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill(rgb).flat()]))));
    assert.equal(await main(['--image', '--model', 'sample/chat'], { ...options, log: line => lines.push(line) }), 0);
    assert.equal(draws, 2);
    assert.match(lines.join('\n'), new RegExp(`本次图片：${color}色`));
    assert.match(lines.join('\n'), /产生少量费用/);
  });
}
test('gateway --image：错色、无中文颜色和跨文本块或消息含多种颜色均失败', async () => {
  for (const [index, color] of ['红', '绿', '蓝'].entries()) {
    const others = ['红', '绿', '蓝'].filter(item => item !== color);
    for (const answer of [...others.map(other => `可能是${color}色或${other}色`), [[color, others[0]]], [[color], [others[1]]], ...others, 'red', '']) {
      const mock = mockGateway(answer), lines = [];
      assert.equal(await main(['--model', 'sample/chat', '--image'], { environment, registry, ...mock, random: () => index / 3, log: line => lines.push(line) }), 1);
      assert.equal(mock.calls.length, 2); assert.match(lines.join('\n'), /看图失败/);
      assert.match(lines.join('\n'), new RegExp(`本次图片：${color}色`));
      assert.doesNotMatch(lines.join('\n'), /sk-bf-fixture-gateway|fixture-provider/);
    }
  }
});
test('gateway --image：必须显式给模型，参数与费用提示可离线验证', async () => {
  const mock = mockGateway(), lines = [];
  assert.equal(await main(['--image'], { environment, registry, ...mock, log: line => lines.push(line) }), 1);
  assert.equal(mock.calls.length, 0); assert.match(lines.join('\n'), /必须同时指定 --model/);
  assert.match(lines.join('\n'), /产生费用/);
  assert.equal(await main(['--image', '--model', 'sample/chat'], { environment, registry, ...mock, random: () => 0, log() {} }), 0);
});

function mockRoutingHeaders(headers, fallbackCheck) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const kind = body.tools ? 'search' : body.input[0].content.some(part => part.type === 'input_image') ? 'image' : 'chat';
    return new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: kind === 'image' ? '红色' : 'OK' }] }, ...(kind === 'search' ? [{ type: 'web_search_call' }] : [])],
      usage: { input_tokens: 3, output_tokens: 1 },
    }), { headers: !fallbackCheck || kind === fallbackCheck ? headers : {} });
  };
}
for (const [kind, label] of [['chat', '对话'], ['search', '联网搜索'], ['image', '看图']]) {
  test(`gateway：${label}由备用作答时判失败并记录备用模型`, async () => {
    const options = { environment, registry, random: () => 0, fetcher: mockRoutingHeaders({
      'x-bifrost-routing-info-is-fallback': 'true',
      'x-bifrost-provider': 'backup',
      'x-bifrost-resolved-model': 'vision',
    }, kind) };
    const report = await checkGateway({ ...options, model: 'sample/chat', search: true, image: true });
    assert.equal(report.exitCode, 1);
    for (const check of ['chat', 'search', 'image']) {
      assert.equal(report.rows[0][check], check !== kind);
      assert.equal(report.rows[0][`${check}Fallback`], check === kind ? 'backup/vision' : null);
    }
    assert.equal(report.rows[0].inputTokens, 9); assert.equal(report.rows[0].outputTokens, 3);
    assert.ok(report.messages.includes(`sample/chat：${label}失败（主模型没有作答，由备用 backup/vision 回答）。`));
    const lines = [];
    assert.equal(await main(['--model', 'sample/chat', '--search', '--image'], { ...options, log: line => lines.push(line) }), 1);
    const tableRow = lines.find(line => line.startsWith('| sample/chat |')).split(' | ');
    assert.equal(tableRow[{ chat: 2, search: 3, image: 4 }[kind]], '✗（备用作答）');
    assert.match(lines.join('\n'), /主模型没有作答，由备用 backup\/vision 回答/);
  });
}
test('gateway：备用响应缺少服务商或模型时使用备用模型说明', async () => {
  for (const metadata of [{}, { 'x-bifrost-provider': 'backup' }, { 'x-bifrost-resolved-model': 'vision' }]) {
    const report = await checkGateway({ environment, registry, model: 'sample/chat', fetcher: mockRoutingHeaders({
      'x-bifrost-routing-info-is-fallback': 'true', ...metadata,
    }) });
    assert.equal(report.exitCode, 1);
    assert.equal(report.rows[0].chat, false);
    assert.equal(report.rows[0].chatFallback, '备用模型');
    assert.ok(report.messages.includes('sample/chat：对话失败（主模型没有作答，由备用模型回答）。'));
  }
});
test('gateway：没有响应头或未走备用时三种检查仍通过', async () => {
  for (const headers of [{}, { 'x-bifrost-provider': 'sample', 'x-bifrost-resolved-model': 'chat' }, {
    'x-bifrost-routing-info-is-fallback': 'false', 'x-bifrost-provider': 'sample', 'x-bifrost-resolved-model': 'chat',
  }]) {
    const options = { environment, registry, random: () => 0, fetcher: mockRoutingHeaders(headers) };
    const report = await checkGateway({ ...options, model: 'sample/chat', search: true, image: true });
    assert.equal(report.exitCode, 0);
    for (const kind of ['chat', 'search', 'image']) {
      assert.equal(report.rows[0][kind], true);
      assert.equal(report.rows[0][`${kind}Fallback`], null);
    }
    const lines = [];
    assert.equal(await main(['--model', 'sample/chat', '--search', '--image'], { ...options, log: line => lines.push(line) }), 0);
    assert.match(lines.join('\n'), /sample\/chat \| 无 \| ✓ \| ✓ \| ✓ \| 无/);
    assert.doesNotMatch(lines.join('\n'), /备用作答|主模型没有作答/);
  }
});
