import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { previewProbe } from './fixtures/preview-probe.mjs';

function fixture() {
  const events = new EventTarget(), button = {}, messages = [], diagnostics = [], timers = [], frames = [];
  let rejectFetch, fetches = 0;
  const blocked = new DOMException('不透明来源不可访问', 'SecurityError');
  const context = {
    window: {}, document: { querySelector: () => button },
    addEventListener: events.addEventListener.bind(events),
    sessionStorage: { getItem() { throw blocked; } },
    parent: {
      get document() { throw blocked; },
      // postMessage 发送快照；保留引用会掩盖晚到事件没有回传的问题。
      postMessage(message) {
        // 诊断消息单独保留，原有断言仍核对就绪消息与结果快照。
        (message.previewEvent ? diagnostics : messages).push(structuredClone(message));
      }
    },
    fetch() { fetches++; return new Promise((resolve, reject) => { rejectFetch = reject; }); },
    setTimeout(callback) { timers.push(callback); },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; }
  };
  runInNewContext(`(${previewProbe.toString()})();`, context);
  return { button, messages, diagnostics, timers, get fetches() { return fetches; },
    // 本帧里注册的回调留给下一帧，避免替身把两帧合并执行。
    frame: () => { for (const callback of frames.splice(0)) callback(performance.now()); },
    rejectFetch: () => rejectFetch(new TypeError('请求被 CSP 拒绝')),
    load: () => events.dispatchEvent(new Event('load')),
    violate: directive => events.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: directive })) };
}

test('预览探针：加载完成且经过两次动画帧后才回传就绪消息', () => {
  const probe = fixture();
  assert.deepEqual(probe.messages, []);
  assert.equal(probe.fetches, 0);
  assert.equal(typeof probe.button.onclick, 'function');
  probe.load();
  assert.deepEqual(probe.messages, [], 'load 后不能立即回传就绪消息');
  assert.deepEqual(probe.diagnostics, [], 'ready 诊断应与就绪消息同时发送');
  probe.frame();
  assert.deepEqual(probe.messages, [], '第一帧后仍不能回传就绪消息');
  assert.deepEqual(probe.diagnostics, []);
  probe.frame();
  assert.deepEqual(probe.messages, [{ previewReady: true }]);
  assert.deepEqual(probe.diagnostics.map(message => message.previewEvent.stage), ['ready']);
  probe.frame();
  assert.equal(probe.messages.length, 1, '就绪消息只发送一次');
  assert.equal(probe.fetches, 0, '就绪不会提前发起请求');
});

test('预览探针：fetch 先拒绝、CSP 事件晚于旧定时器时仍回传完整结果', async () => {
  const probe = fixture();
  const clicked = probe.button.onclick();
  probe.rejectFetch();
  await new Promise(setImmediate);
  // 推进全部旧回传定时器，确定性重现 CSP 事件排在其后的情形。
  for (const callback of probe.timers) callback();
  assert.deepEqual(probe.messages, [], '尚未观察到 connect-src 时不能回传结果快照');
  probe.violate('img-src');
  await new Promise(setImmediate);
  assert.deepEqual(probe.messages, [], '其他指令不能代替 connect-src');
  probe.violate('connect-src');
  await clicked;
  assert.equal(probe.messages.length, 1);
  const result = probe.messages[0].previewProbe;
  assert.deepEqual(result.violations, ['img-src', 'connect-src']);
  assert.equal(result.text, '脚本已运行');
  assert.match(result.fetch, /^TypeError:/);
  assert.match(result.storage, /^SecurityError:/);
  assert.match(result.parent, /^SecurityError:/);
  assert.equal(probe.fetches, 1);
});

test('预览探针：CSP 事件先到时仍等待 fetch 的失败结果', async () => {
  const probe = fixture();
  const clicked = probe.button.onclick();
  probe.violate('connect-src');
  await new Promise(setImmediate);
  assert.deepEqual(probe.messages, []);
  probe.rejectFetch();
  await clicked;
  for (const callback of probe.timers) callback();
  assert.equal(probe.messages.length, 1);
  assert.deepEqual(probe.messages[0].previewProbe.violations, ['connect-src']);
  assert.match(probe.messages[0].previewProbe.fetch, /^TypeError:/);
});

test('预览探针：连续点击两次只请求和发送快照一次，第二次报告 click-repeat', async () => {
  const probe = fixture();
  const clicked = probe.button.onclick();
  const repeated = probe.button.onclick();
  assert.equal(probe.fetches, 1, '重复点击不能再次发起请求');
  await repeated;
  assert.deepEqual(probe.diagnostics.map(message => message.previewEvent.stage), ['click', 'fetch-start', 'click-repeat']);
  assert.deepEqual(probe.messages, [], '首次点击仍须等待请求与 CSP 事件');
  probe.rejectFetch();
  probe.violate('connect-src');
  await clicked;
  assert.equal(probe.fetches, 1);
  assert.equal(probe.messages.length, 1, '结果快照只发送一次');
  assert.equal(probe.diagnostics.filter(message => message.previewEvent.stage === 'snapshot-sent').length, 1);
});
