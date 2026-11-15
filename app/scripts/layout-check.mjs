// 开发侧 CLI 与 design-check 服务共用；浏览器只采样，判定函数不依赖 DOM。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const defaultViewports = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }];
export function parseViewports(value) {
  return value.split(',').map(size => {
    const match = /^(\d+)x(\d+)$/.exec(size);
    const [width, height] = match ? match.slice(1).map(Number) : [];
    if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('视口无效，请使用 1440x900,1280x720 格式。');
    return { width, height };
  });
}
export function viewportsForScreen(screen, viewports = defaultViewports) {
  return screen.startsWith('app-') ? [{ width: 390, height: 844 }] : viewports;
}
export function describeElement(element) {
  return `${element.tag || '元素'}${(element.classes || []).map(c => `.${c}`).join('')}「${Array.from((element.text || '').replace(/\s+/g, ' ').trim()).slice(0, 20).join('')}」`;
}
const hasText = e => e.visible && !e.occluded && Boolean(e.text?.trim());
const rectOf = e => e.visibleRect || e.rect;
export function checkClipping(e) {
  if (!hasText(e)) return false;
  const x = ['hidden', 'clip'].includes(e.overflowX) && e.scrollWidth > e.clientWidth;
  const y = ['hidden', 'clip'].includes(e.overflowY) && e.scrollHeight > e.clientHeight;
  const r = e.clipRect || e.rect;
  return (e.contentTextRects || []).some(t => (x && (t.left < r.left - 1 || t.right > r.right + 1)) || (y && (t.top < r.top - 1 || t.bottom > r.bottom + 1)));
}
export function checkFontSize(e) { return Boolean(hasText(e) && e.ownText !== false && e.fontSize < 11); }
export function checkOverlap(elements) {
  const texts = elements.filter(e => hasText(e) && e.textRects?.length && e.inViewport !== false);
  const pairs = [];
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    if (a.ancestors?.includes(b.id) || b.ancestors?.includes(a.id)) continue;
    let area = 0;
    for (const x of a.textRects) for (const y of b.textRects) {
      area += Math.max(0, Math.min(x.right, y.right) - Math.max(x.left, y.left)) * Math.max(0, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
    }
    if (area > 4) pairs.push({ a, b, area });
  }
  return pairs;
}
const issue = (code, element, reason, severity = 'error') => ({ code, severity, element, reason });
export function checkLayout(snapshot) {
  const { viewport, document: doc, elements } = snapshot;
  const issues = [];
  if (doc.scrollWidth > viewport.width || doc.scrollHeight > viewport.height) issues.push(issue('page-scroll', 'html', `整页尺寸 ${doc.scrollWidth}×${doc.scrollHeight} 超出视口，不符合一屏原则。`));
  for (const e of elements.filter(e => e.visible && !e.occluded)) {
    const name = describeElement(e), rect = rectOf(e);
    if (checkClipping(e)) issues.push(issue('text-clipped', name, '文字被裁切：变换后的文字矩形超出容器裁剪边界 1px 以上。'));
    if (checkFontSize(e)) issues.push(issue('small-font', name, `字号 ${e.fontSize}px 小于 11px。`, 'warning'));
    if (rect.right > viewport.width || rect.bottom > viewport.height) issues.push(issue('outside-viewport', name, `右边 ${rect.right.toFixed(2)}px 或下边 ${rect.bottom.toFixed(2)}px 超出视口。`));
  }
  for (const { a, b, area } of checkOverlap(elements)) issues.push(issue('text-overlap', `${describeElement(a)} ↔ ${describeElement(b)}`, `文字字形矩形重叠 ${area.toFixed(2)}px²，大于 4px²。`));
  return issues;
}

export function outlineEntries(outline) {
  if (!Array.isArray(outline?.groups)) return [];
  return outline.groups.flatMap(group => Array.isArray(group?.screens) ? group.screens.flatMap(screen => Array.isArray(screen?.states) ? screen.states.map(state => ({ screen: screen.id, state, group: group.id })) : []) : []);
}
const keyOf = e => JSON.stringify([e.screen, e.state]);
export function checkOutline(outline, sections, links = []) {
  const issues = [], entries = outlineEntries(outline);
  const mismatch = (reason, entry = {}) => issues.push({ ...issue('outline-mismatch', 'design-outline / section', reason), screen: entry.screen, state: entry.state });
  if (!entries.length) mismatch('缺少有效的 design-outline 屏幕与状态。');
  const groups = new Set(), screens = new Set();
  for (const group of Array.isArray(outline?.groups) ? outline.groups : []) {
    if (typeof group?.id !== 'string' || !group.id || groups.has(group?.id) || !Array.isArray(group?.screens) || !group.screens.length) mismatch('大纲分组无效、重复或没有屏幕。');
    groups.add(group?.id);
    for (const screen of Array.isArray(group?.screens) ? group.screens : []) {
      if (typeof screen?.id !== 'string' || !screen.id || screens.has(screen?.id) || !Array.isArray(screen?.states) || !screen.states.length) mismatch('大纲屏幕无效、重复或没有状态。');
      screens.add(screen?.id);
    }
  }
  const expected = new Map(), actual = new Map();
  for (const e of entries) {
    if (typeof e.state !== 'string' || !e.state) mismatch('大纲状态必须是非空字符串。');
    const key = keyOf(e);
    if (expected.has(key)) mismatch(`大纲重复：${e.screen} / ${e.state}。`, e);
    expected.set(key, e);
  }
  for (const e of sections) {
    const key = keyOf(e);
    if (actual.has(key)) mismatch(`section 重复：${e.screen} / ${e.state}。`, e);
    actual.set(key, e);
    if (!expected.has(key)) mismatch(`section 未列入大纲：${e.screen} / ${e.state}。`, e);
    else if (expected.get(key).group !== e.group) mismatch(`分组不一致：${e.screen} / ${e.state}。`, e);
  }
  for (const [key, e] of expected) if (!actual.has(key)) mismatch(`大纲缺少 section：${e.screen} / ${e.state}。`, e);
  for (const link of links) {
    const index = link.target.indexOf('#');
    if (index < 0) continue;
    const params = new URLSearchParams(link.target.slice(index + 1));
    if (!params.has('screen')) continue;
    const target = { screen: params.get('screen'), state: params.get('state') || 'default' };
    if (!expected.has(keyOf(target))) issues.push({ ...issue('missing-target', link.element || '跳转链接', `定位目标不存在：${target.screen} / ${target.state}。`), screen: link.screen, state: link.state });
  }
  return issues;
}

// 独立的浏览器采样段：只返回 JSON 数据，不把页面对象带到宿主。
export function collectLayout() {
  const all = [...document.querySelectorAll('*')];
  const ids = new Map(all.map((e, i) => [e, i]));
  const rect = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const text = e => (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value || e.placeholder : e.innerText ?? e.textContent) || '';
  const styleVisible = e => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const positive = r => r.right > r.left && r.bottom > r.top;
  const geometry = new Map(all.filter(e => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(e.tagName) && styleVisible(e)).map(e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    const sx = e.offsetWidth ? r.width / e.offsetWidth : 1, sy = e.offsetHeight ? r.height / e.offsetHeight : 1;
    return [e, { rect: rect(r), style: s, clipRect: { left: r.left + e.clientLeft * sx, top: r.top + e.clientTop * sy,
      right: r.left + (e.clientLeft + e.clientWidth) * sx, bottom: r.top + (e.clientTop + e.clientHeight) * sy } }];
  }));
  const clipped = (r, start, stop = null) => {
    const result = { ...r };
    for (let p = start; p && p !== stop; p = p.parentElement) {
      // html/body 的裁剪不能掩盖一屏溢出；区域内滚动只检查当前可见部分。
      if (p === document.body || p === document.documentElement || !geometry.has(p)) continue;
      const { style: s, clipRect: pr } = geometry.get(p);
      if (['auto', 'scroll', 'hidden', 'clip'].includes(s.overflowX)) {
        result.left = Math.max(result.left, pr.left); result.right = Math.min(result.right, pr.right);
      }
      if (['auto', 'scroll', 'hidden', 'clip'].includes(s.overflowY)) {
        result.top = Math.max(result.top, pr.top); result.bottom = Math.min(result.bottom, pr.bottom);
      }
    }
    return result;
  };
  const occluded = (r, owner) => {
    const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    // 视口外没有命中测试结果，不能据此认定遮挡并掩盖真实越界。
    if (right <= left || bottom <= top) return false;
    const dx = Math.min(2, (right - left) / 2), dy = Math.min(2, (bottom - top) / 2);
    return ![[(left + right) / 2, (top + bottom) / 2], [left + dx, top + dy], [right - dx, top + dy], [left + dx, bottom - dy], [right - dx, bottom - dy]].some(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit === owner || (hit && owner.contains(hit));
    });
  };
  const own = new Map(), descendants = new Map();
  const pointerStyles = [];
  try {
    // 遮罩与缩略图常禁用鼠标事件；视觉遮挡采样不能因此穿透，结束后原样恢复内联样式。
    for (const [e, { style: s }] of geometry) {
      if (s.pointerEvents !== 'none') continue;
      pointerStyles.push([e, e.getAttribute('style')]);
    }
    for (const [e] of pointerStyles) e.style.setProperty('pointer-events', 'auto', 'important');
    for (const e of geometry.keys()) {
      const fragments = [];
      for (const n of e.childNodes) {
        if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (!positive(r)) continue;
          const raw = rect(r), visible = clipped(raw, e);
          fragments.push({ owner: e, raw, visible, occluded: positive(visible) && occluded(visible, e) });
        }
      }
      own.set(e, fragments);
      for (let p = e; p; p = p.parentElement) {
        if (!descendants.has(p)) descendants.set(p, []);
        descendants.get(p).push(...fragments);
      }
    }
  } finally {
    for (const [e, value] of pointerStyles) {
      if (value === null) e.removeAttribute('style'); else e.setAttribute('style', value);
    }
  }
  const elements = [];
  for (const [e, { rect: r, style: s, clipRect }] of geometry) {
    const visibleRect = clipped(r, e.parentElement), ancestors = [];
    for (let p = e.parentElement; p; p = p.parentElement) ancestors.push(ids.get(p));
    const fragments = descendants.get(e) || [], visibleFragments = fragments.filter(f => positive(f.visible));
    // 截断复核保留当前容器裁剪前的文字；先应用内部子容器裁剪，避免将合法滚动内容算作溢出。
    const contentTextRects = fragments.filter(f => !f.occluded).map(f => clipped(f.raw, f.owner, e)).filter(positive);
    elements.push({ id: ids.get(e), tag: e.tagName.toLowerCase(), classes: [...e.classList], text: text(e), ancestors,
      occluded: visibleFragments.length > 0 && visibleFragments.every(f => f.occluded),
      textRects: (own.get(e) || []).filter(f => positive(f.visible) && !f.occluded).map(f => f.visible), contentTextRects, clipRect,
      visible: visibleRect.right > visibleRect.left && visibleRect.bottom > visibleRect.top,
      inViewport: visibleRect.right > 0 && visibleRect.bottom > 0 && visibleRect.left < innerWidth && visibleRect.top < innerHeight,
      ownText: e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()),
      leaf: e.children.length === 0, rect: r, visibleRect, fontSize: parseFloat(s.fontSize), overflowX: s.overflowX, overflowY: s.overflowY,
      scrollWidth: e.scrollWidth, scrollHeight: e.scrollHeight, clientWidth: e.clientWidth, clientHeight: e.clientHeight });
  }
  const sections = [...document.querySelectorAll('section[data-screen]')].map(e => ({ screen: e.dataset.screen, state: e.dataset.state, group: e.dataset.group, visible: styleVisible(e) }));
  const links = [...document.querySelectorAll('[data-to], [href]')].flatMap(e => ['data-to', 'href'].filter(a => e.hasAttribute(a)).map(a => ({ target: e.getAttribute(a), element: `${e.tagName.toLowerCase()}${[...e.classList].map(c => '.' + c).join('')}「${Array.from(text(e).replace(/\s+/g, ' ').trim()).slice(0, 20).join('')}」`, screen: e.closest('section[data-screen]')?.dataset.screen, state: e.closest('section[data-screen]')?.dataset.state })));
  const outlines = document.querySelectorAll('script#design-outline[type="application/json"]');
  let outline = null;
  try { if (outlines.length === 1) outline = JSON.parse(outlines[0].textContent); } catch { /* 无效大纲由纯函数报告，不掩盖为通过。 */ }
  return { outline, sections, links, elements, viewport: { width: innerWidth, height: innerHeight }, document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight } };
}

export function findChrome(env = process.env) {
  const candidates = env.CHROME_PATH ? [env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].filter(k => env[k]).flatMap(k => [path.join(env[k], 'Google/Chrome/Application/chrome.exe'), path.join(env[k], 'Chromium/Application/chrome.exe')]),
  ];
  return candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}
const timeoutMs = 10000;
async function startChrome(chromePath, chromeArgs = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-check-'));
  const proc = spawn(chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-gpu', ...chromeArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  const exited = new Promise(resolve => { proc.once('exit', resolve); proc.once('error', resolve); });
  const close = async () => {
    ws?.close();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(timer);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let buffer = '';
      const finish = (error, value) => { clearTimeout(timer); proc.stderr.off('data', onData); proc.off('exit', onExit); proc.off('error', onError); error ? reject(error) : resolve(value); };
      const onData = chunk => { buffer = (buffer + chunk).slice(-8192); const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (match) finish(null, match[1]); };
      const onExit = () => finish(Error('Chrome 提前退出，请检查本机运行权限。'));
      const onError = () => finish(Error('无法启动 Chrome，请检查 CHROME_PATH 与执行权限。'));
      const timer = setTimeout(() => finish(Error('Chrome 未在 60 秒内启动，请检查运行环境。')), 60000);
      proc.stderr.on('data', onData); proc.once('exit', onExit); proc.once('error', onError);
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(Error('连接 Chrome 超时。')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('无法连接 Chrome。')); }, { once: true });
    });
    let id = 0;
    const pending = new Map(), listeners = new Set();
    const fail = () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error('Chrome 连接中断。')); } pending.clear(); };
    ws.addEventListener('close', fail); ws.addEventListener('error', fail);
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id); pending.delete(msg.id); clearTimeout(timer);
        msg.error ? reject(Error('Chrome 调试命令失败，请核对 Chrome 版本与页面状态。')) : resolve(msg.result);
      } else for (const listener of listeners) listener(msg);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => { pending.delete(n); reject(Error(`Chrome 命令超时：${method}。`)); }, timeoutMs);
      pending.set(n, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    return { close, listeners, sessionId, send: (method, params) => send(method, params, sessionId) };
  } catch (error) { await close(); throw error; }
}

export async function checkDesign(file, { viewports = defaultViewports, chromePath = findChrome(), chromeArgs = [] } = {}) {
  if (!chromePath) throw Error('找不到 Chrome。请安装 Google Chrome 或 Chromium，或用 CHROME_PATH 指定可执行文件。');
  try { if (!fs.statSync(file).isFile()) throw Error(); } catch { throw Error('HTML 文件不可读取，请检查文件路径。'); }
  const browser = await startChrome(chromePath, chromeArgs);
  const report = { schemaVersion: 1, file: path.basename(file), status: 'completed', checks: [], issues: [], errors: 0, warnings: 0 };
  let context = { screen: null, state: null, viewport: null }, eventIssues = [], requestIds = new Set(), interceptionError;
  const allowed = url => /^(file|data|blob):/i.test(url);
  const recordRequest = (url, id) => {
    if (allowed(url) || requestIds.has(id)) return;
    requestIds.add(id);
    eventIssues.push(issue('external-request', '网络请求', `出现 file、data、blob 以外的请求（${url.split(':')[0]}）。`));
  };
  const listener = msg => {
    if (msg.sessionId !== browser.sessionId) return;
    const p = msg.params;
    if (msg.method === 'Runtime.exceptionThrown' || (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') || (msg.method === 'Log.entryAdded' && p.entry.level === 'error')) eventIssues.push(issue('console-error', '控制台', `出现错误（${msg.method}${p.entry?.source ? ' / ' + p.entry.source : ''}），请打开对应屏检查控制台。`));
    if (msg.method === 'Network.requestWillBeSent') recordRequest(p.request.url, p.requestId);
    if (msg.method === 'Network.webSocketCreated') recordRequest(p.url, p.requestId);
    if (msg.method === 'Fetch.requestPaused') {
      const external = !allowed(p.request.url);
      if (external) recordRequest(p.request.url, p.networkId || p.requestId);
      browser.send(external ? 'Fetch.failRequest' : 'Fetch.continueRequest', external ? { requestId: p.requestId, errorReason: 'BlockedByClient' } : { requestId: p.requestId }).catch(() => { interceptionError = Error('无法处理浏览器请求拦截，检查未完成。'); });
    }
  };
  browser.listeners.add(listener);
  const evaluate = async expression => {
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error('页面采样失败，请检查页面脚本与 Chrome 版本。');
    return result.result.value;
  };
  const open = async (url, viewport) => {
    await browser.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    let onLoad, timer;
    const loaded = new Promise((resolve, reject) => {
      onLoad = msg => { if (msg.sessionId === browser.sessionId && msg.method === 'Page.loadEventFired') resolve(); };
      browser.listeners.add(onLoad);
      timer = setTimeout(() => reject(Error('页面加载超时，布局检查未完成。')), timeoutMs);
    });
    try {
      // Promise.all 立即接管加载超时，避免导航失败后留下未处理的拒绝。
      await Promise.all([loaded, browser.send('Page.navigate', { url }).then(result => { if (result.errorText) throw Error('页面导航失败，请检查 HTML 文件。'); })]);
      await evaluate('(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()');
      if (interceptionError) throw interceptionError;
      return await evaluate(`(${collectLayout.toString()})()`);
    } finally { clearTimeout(timer); browser.listeners.delete(onLoad); }
  };
  const append = issues => { for (const item of issues) report.issues.push({ ...context, ...item, screen: item.screen ?? context.screen, state: item.state ?? context.state }); };
  try {
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map(method => browser.send(method)));
    // 本机检查也阻止页面联网；服务部署仍需独立的无网络容器边界。
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    const base = pathToFileURL(path.resolve(file));
    const initial = await open(base.href, viewports[0]);
    append(checkOutline(initial.outline, initial.sections, initial.links));
    append(eventIssues);
    const entries = [...new Map(outlineEntries(initial.outline).map(e => [keyOf(e), e])).values()];
    for (const entry of entries) {
      if (typeof entry.screen !== 'string' || typeof entry.state !== 'string') continue;
      for (const viewport of viewportsForScreen(entry.screen, viewports)) {
        context = { screen: entry.screen, state: entry.state, viewport };
        // 等待空白页加载结束，避免其 load 事件被误认为目标页面已完成。
        await open('about:blank', viewport);
        eventIssues = []; requestIds = new Set();
        const target = new URL(base); target.hash = new URLSearchParams({ screen: entry.screen, state: entry.state }).toString();
        const snapshot = await open(target.href, viewport);
        const active = snapshot.sections.filter(s => s.visible);
        if (active.length !== 1 || keyOf(active[0]) !== keyOf(entry)) append([issue('route-mismatch', 'section', '定位 hash 未唯一显示指定屏幕与状态。')]);
        append(checkLayout(snapshot));
        append(checkOutline(snapshot.outline, snapshot.sections, snapshot.links));
        append(eventIssues);
        report.checks.push(context);
      }
    }
    report.errors = report.issues.filter(i => i.severity === 'error').length;
    report.warnings = report.issues.filter(i => i.severity === 'warning').length;
    return report;
  } finally { browser.listeners.delete(listener); await browser.close(); }
}

export function formatReport(report) {
  const lines = [`布局校验：${report.errors} 个错误，${report.warnings} 个警告；检查 ${report.checks.length} 个屏幕 / 状态 / 视口组合。`];
  for (const i of report.issues) lines.push(`[${i.severity === 'error' ? '错误' : '警告'}] 屏 ${i.screen ?? '全局'} / 状态 ${i.state ?? '全局'} / 视口 ${i.viewport ? `${i.viewport.width}×${i.viewport.height}` : '全局'} / ${i.element}：${i.reason}`);
  return lines.join('\n');
}
export async function main(args = process.argv.slice(2)) {
  let file, jsonPath, viewports = defaultViewports;
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (['--viewports', '--json'].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw Error('选项缺少参数。');
        if (arg === '--json') jsonPath = value; else viewports = parseViewports(value);
      } else if (!file && !arg.startsWith('--')) file = arg;
      else throw Error('无法识别参数。');
    }
    if (!file) throw Error('用法：node app/scripts/layout-check.mjs <html> [--viewports 1440x900,1280x720] [--json 报告路径]');
    if (jsonPath && path.resolve(jsonPath) === path.resolve(file)) throw Error('报告路径不能覆盖输入 HTML。');
    const report = await checkDesign(file, { viewports });
    if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(formatReport(report) + '\n');
    return report.errors ? 1 : 0;
  } catch (error) {
    // 文件系统错误不回显路径或任意页面内容。
    process.stderr.write(`布局检查无法运行：${error.code ? '文件或报告无法读写，请检查路径和权限。' : error.message}\n`);
    return 2;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
