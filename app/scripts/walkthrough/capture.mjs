import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { checkLayout, collectLayout, findChrome, startChrome } from '../layout-check.mjs';
import { compareResources } from './model.mjs';

const publicSegments = new Set('app ui auth login me logout api sessions state workbench tasks message messages items preview files drafts modules styles.css app.js app.mjs index.html favicon.ico icon.png'.split(' '));
export function route(url, routes = []) {
  const parts = new URL(url).pathname.split('/');
  for (const template of routes) {
    const segments = template.split('/');
    if (segments.length === parts.length && segments.every((segment, i) => segment === parts[i] || (segment === ':id' && parts[i]))) return template;
  }
  return parts.map(s => !s || publicSegments.has(s) ? s : ':参数').join('/');
}
const assetKey = url => route(url) + '#' + createHash('sha256').update(new URL(url).pathname).digest('hex').slice(0, 16);

async function evaluate(browser, expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error('页面操作失败，请核对选择器与产品状态。');
  return result.result.value;
}
async function visible(browser, selector, origin) {
  for (let i = 0; i < 50; i++) {
    const ok = await evaluate(browser, `(() => {
      if (location.origin !== ${JSON.stringify(origin)}) return false;
      const e = document.querySelector(${JSON.stringify(selector)});
      return !!e && !e.disabled && e.getClientRects().length > 0 && getComputedStyle(e).visibility === 'visible';
    })()`);
    if (ok) return;
    await delay(100);
  }
  throw Error('未出现计划指定的可操作元素：' + selector);
}
async function navigate(browser, url) {
  let loaded, timer;
  const ready = new Promise((resolve, reject) => {
    loaded = event => { if (event.sessionId === browser.sessionId && event.method === 'Page.loadEventFired') resolve(); };
    browser.listeners.add(loaded);
    timer = setTimeout(() => reject(Error('产品页面加载超时。')), 10000);
  });
  try {
    // 同文档 hash 导航没有 load 事件，使用导航结果区分。
    ready.catch(() => {});
    const result = await browser.send('Page.navigate', { url });
    if (result?.errorText) throw Error('无法打开计划中的产品路径。');
    if (result?.loaderId) await ready;
  } finally { clearTimeout(timer); browser.listeners.delete(loaded); }
}
async function perform(browser, steps, ready, origin, env) {
  for (const step of steps) {
    if (step.open) { await navigate(browser, new URL(step.open, origin).href); continue; }
    const selector = step.wait || step.click || step.fill.selector;
    await visible(browser, selector, origin);
    const element = `document.querySelector(${JSON.stringify(selector)})`;
    if (step.click) await evaluate(browser, `${element}.click()`);
    if (step.fill) {
      const value = step.fill.fromEnv ? env[step.fill.fromEnv] : step.fill.value;
      if (typeof value !== 'string') throw Error('测试账号输入环境变量未设置：' + step.fill.fromEnv);
      await evaluate(browser, `(() => {const e=${element};e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    }
  }
  await visible(browser, ready, origin);
  await evaluate(browser, '(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()');
}
function monitor(browser, origin, routes) {
  let current;
  const activeRequests = new Map(), documents = new Map();
  const listener = ({ method, params: p, sessionId }) => {
    if (sessionId !== browser.sessionId) return;
    if (method === 'Fetch.requestPaused') {
      const allowed = new URL(p.request.url).origin === origin;
      if (!allowed) current?.diagnostics.push({ type: 'external', reason: '产品请求了其他来源的资源。' });
      browser.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: p.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }).catch(() => {});
    }
    if (!current) return;
    if (method === 'Runtime.exceptionThrown' || (method === 'Runtime.consoleAPICalled' && p.type === 'error') || (method === 'Log.entryAdded' && p.entry.level === 'error')) {
      const detail = p.exceptionDetails || p.entry || p;
      const frame = detail.stackTrace?.callFrames?.[0] || detail;
      const location = {};
      if (frame.url && /^https?:/.test(frame.url)) location.path = route(frame.url, routes);
      if (Number.isInteger(frame.lineNumber)) location.line = frame.lineNumber + 1;
      const kind = detail.exception?.className;
      current.diagnostics.push({ type: 'console', reason: ['TypeError','RangeError','ReferenceError','SyntaxError'].includes(kind) ? kind : '浏览器记录了错误。', source: method, ...location });
    }
    if (method === 'Network.requestWillBeSent') {
      const url = new URL(p.request.url);
      if (url.origin === origin) activeRequests.set(p.requestId, { method: p.request.method, path: route(url, routes), key: assetKey(url), loader: p.loaderId, start: p.timestamp, state: current });
    }
    const req = activeRequests.get(p.requestId);
    if (!req) return;
    const details = { method: req.method, path: req.path };
    if (method === 'Network.responseReceived') {
      if (p.response.status >= 400) req.state.diagnostics.push({ type: 'http', ...details, status: p.response.status });
      else if (['Script', 'Stylesheet'].includes(p.type)) req.asset = true;
    }
    if (method === 'Network.loadingFailed') {
      if (!p.canceled) req.state.diagnostics.push({ type: 'network', ...details, reason: '请求未完成。' });
      activeRequests.delete(p.requestId);
    }
    if (method === 'Network.loadingFinished') {
      const durationMs = Math.round((p.timestamp - req.start) * 1000);
      if (durationMs > 2000) req.state.diagnostics.push({ type: 'slow', ...details, durationMs });
      if (req.asset) req.state.pending.push(browser.send('Network.getResponseBody', { requestId: p.requestId }).then(({ body, base64Encoded }) => {
        if (!documents.has(req.loader)) documents.set(req.loader, {});
        documents.get(req.loader)[req.key] = createHash('sha256').update(Buffer.from(body, base64Encoded ? 'base64' : 'utf8')).digest('hex');
      }).catch(() => {}));
      activeRequests.delete(p.requestId);
    }
  };
  browser.listeners.add(listener);
  return { observe(state) { current = state; activeRequests.clear(); }, resources: loader => ({ ...documents.get(loader) }) };
}

export async function capture(plan, review, output, origin, env = process.env) {
  const chrome = findChrome(env);
  if (!chrome) throw Error('请使用脚手架的 Chromium 容器，或设置 CHROME_PATH。');
  const args = [];
  if (env.WALKTHROUGH_CONTAINER === '1') {
    // 浏览器保留宿主回环 origin 供服务端校验，只把这个入口的 TCP 连接交给同项目 Caddy。
    const { address } = await lookup('caddy', { family: 4 });
    args.push('--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--host-resolver-rules=MAP ' + new URL(origin).host + ' ' + address + ':80');
  }
  const browser = await startChrome(chrome, args);
  try {
    const { observe, resources } = monitor(browser, origin, plan.diagnosticRoutes || []);
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await browser.send(domain + '.enable');
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    const viewport = plan.viewport || { width: 1440, height: 900 };
    if (![viewport.width, viewport.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) throw Error('请提供有效的浏览器视口尺寸。');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    fs.mkdirSync(path.join(output, 'shots'));
    for (const g of review.groups) for (const s of g.screens) {
      const screen = plan.groups.find(group => group.id === g.id).screens.find(screen => screen.id === s.id);
      for (const state of s.states) {
        const scene = screen.capture[state.state];
        let loader;
        state.pending = [];
        observe(state);
        try {
          if (scene.unavailableReason) throw Error(scene.unavailableReason);
          await perform(browser, scene.steps, scene.ready, origin, env);
          loader = (await browser.send('Page.getFrameTree')).frameTree.frame.loaderId;
          const snapshot = await evaluate(browser, `(${collectLayout.toString()})()`);
          for (const { code, severity, reason } of checkLayout(snapshot)) state.diagnostics.push({ type: 'layout', code, severity, reason });
          const file = path.join('shots', [g.order, s.position, g.id, s.id, state.state].join('_') + '.png');
          const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          fs.writeFileSync(path.join(output, file), Buffer.from(data, 'base64'), { flag: 'wx' });
          state.screenshot = 'data:image/png;base64,' + data;
          state.screenshotPath = file;
        } catch (error) { state.unavailableReason = error.message; }
        finally {
          observe(null);
          await Promise.all(state.pending);
          state.resources = resources(loader);
          delete state.pending;
          compareResources(state, plan.source.version);
        }
      }
    }
  } finally { await browser.close(); }
}
