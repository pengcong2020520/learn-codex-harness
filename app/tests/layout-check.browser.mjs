import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { checkDesign, findChrome } from '../scripts/layout-check.mjs';

const chrome = findChrome();
const options = { timeout: 90000, skip: !chrome && '未找到 Chrome；安装 Chrome 或设置 CHROME_PATH 后运行 npm run test:web。' };
const fixture = name => fileURLToPath(new URL(`./fixtures/layout/${name}.html`, import.meta.url));
for (const [name, code] of [['clean', null], ['scroll', 'page-scroll'], ['overlap', 'text-overlap'], ['clipped', 'text-clipped'], ['occlusion', null], ['scaled-preview', null]]) {
  test(`布局浏览器夹具：${name}`, options, async () => {
    const report = await checkDesign(fixture(name));
    assert.equal(report.checks.length, 2);
    if (code) assert.ok(report.issues.some(i => i.code === code), JSON.stringify(report));
    else assert.equal(report.errors, 0, JSON.stringify(report));
    for (const i of report.issues) assert.ok(i.element && i.reason && 'screen' in i && 'state' in i && 'viewport' in i);
  });
}

test('布局浏览器夹具：标题与角标 padding 相交不报错，只有字形相交才报错', options, async () => {
  const report = await checkDesign(fixture('padded-badge'));
  assert.equal(report.checks.length, 4);
  assert.deepEqual(report.issues.filter(i => i.state === 'default'), [], JSON.stringify(report));
  assert.equal(report.errors, 2, JSON.stringify(report));
  assert.equal(report.issues.length, 2, JSON.stringify(report));
  for (const i of report.issues) {
    assert.equal(i.state, 'overlap');
    assert.equal(i.code, 'text-overlap');
    assert.match(i.element, /b「UI title」.*span\.badge「V 2」/);
  }
});

test('布局浏览器：遮罩本身的文字重叠仍报错', options, async t => {
  const html = fs.readFileSync(fixture('occlusion'), 'utf8').replace('</style>', '.drawer p{position:absolute;left:20px;top:20px;width:160px;font:14px/20px monospace;white-space:nowrap;text-align:justify;text-align-last:justify}.drawer p+p{left:40px;top:26px}</style>')
    .replace('<p>版本历史</p>', '<p>Version history</p><p>Other drawer text</p>');
  const report = await checkDesign(temporary(t, html));
  assert.equal(report.errors, 2, JSON.stringify(report));
  assert.ok(report.issues.every(i => i.code === 'text-overlap' && i.element.includes('Version history') && i.element.includes('Other drawer text')), JSON.stringify(report));
});

test('布局浏览器：禁用鼠标事件的缩略图文字实际超出时仍报截断', options, async t => {
  const html = fs.readFileSync(fixture('scaled-preview'), 'utf8').replace('width:240px;height:140px', 'width:90px;height:140px');
  const report = await checkDesign(temporary(t, html));
  assert.equal(report.errors, 2, JSON.stringify(report));
  assert.ok(report.issues.every(i => i.code === 'text-clipped' && i.element.startsWith('div.wprev')), JSON.stringify(report));
});

function temporary(t, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.html'); fs.writeFileSync(file, html);
  return file;
}
const clean = () => fs.readFileSync(fixture('clean'), 'utf8');
test('布局浏览器：隐藏内容不误报；两个 App 状态各检查一次，流程自动推进保持关闭', options, async t => {
  const html = clean().replaceAll('web-home', 'app-home').replace('["default"]', '["default","loading"]')
    .replace('</section>', '</section><section data-screen="app-home" data-state="loading" data-group="main"><p>正在生成</p></section>')
    .replace('</html>', `<script>
      function show(){const p=new URLSearchParams(location.hash.slice(1));document.querySelectorAll('section').forEach(e=>e.style.display=e.dataset.state===(p.get('state')||'default')?'flex':'none');if(p.has('auto'))throw Error('不应自动推进');}
      addEventListener('hashchange',show);show();
    </script></html>`);
  const report = await checkDesign(temporary(t, html));
  assert.equal(report.errors, 0, JSON.stringify(report));
  assert.deepEqual(report.checks.map(c => c.state), ['default', 'loading']);
  assert.ok(report.checks.every(c => c.viewport.width === 390 && c.viewport.height === 844));
});

test('布局浏览器：缺失目标、section、控制台错误、外部请求都失败', options, async t => {
  const html = clean().replace('</section>', '<a href="#screen=missing&state=default">失效链接</a></section>')
    .replace('["default"]', '["default","empty"]')
    .replace('</html>', '<script>console.error("夹具错误");fetch("https://example.com/layout-fixture").catch(()=>{});</script></html>');
  const report = await checkDesign(temporary(t, html), { viewports: [{ width: 800, height: 600 }] });
  for (const code of ['missing-target', 'outline-mismatch', 'console-error', 'external-request', 'route-mismatch']) assert.ok(report.issues.some(i => i.code === code), code);
});

test('布局浏览器 CLI：成功为 0、布局错误为 1，JSON 与中文摘要一致', options, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, expected] of [['clean', 0], ['overlap', 1]]) {
    const json = path.join(dir, `${name}.json`);
    const proc = spawn(process.execPath, [fileURLToPath(new URL('../scripts/layout-check.mjs', import.meta.url)), fixture(name), '--viewports', '800x600', '--json', json], { env: { ...process.env, CHROME_PATH: chrome } });
    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
    assert.equal(code, expected, stderr);
    const report = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.ok(stdout.includes(`${report.errors} 个错误，${report.warnings} 个警告`));
  }
});
