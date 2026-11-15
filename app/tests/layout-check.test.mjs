import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { checkOverlap, checkClipping, checkFontSize, checkLayout, checkOutline, parseViewports, viewportsForScreen, describeElement } from '../scripts/layout-check.mjs';

const box = (id, left = 0, top = 0, width = 10, height = 10) => {
  const rect = { left, top, right: left + width, bottom: top + height };
  return ({
  id, tag: 'span', classes: ['label'], text: '文字', visible: true, leaf: true,
  ancestors: [], rect, textRects: [rect], contentTextRects: [rect], occluded: false,
  fontSize: 12, overflowX: 'visible', overflowY: 'visible',
  clientWidth: width, clientHeight: height, scrollWidth: width, scrollHeight: height,
  });
};

test('文字重叠只报告大于 4 平方像素的可见非祖孙字形', () => {
  const a = box('a'), b = box('b', 8, 8);
  assert.equal(checkOverlap([a, b]).length, 0);
  b.rect.left = 7;
  assert.equal(checkOverlap([a, b]).length, 1);
  assert.equal(checkOverlap([a, { ...b, ancestors: ['a'] }]).length, 0);
  assert.equal(checkOverlap([a, { ...b, visible: false }]).length, 0);
  assert.equal(checkOverlap([a, { ...b, leaf: false }]).length, 1, '混合内容元素自己的文本也要检查');
  assert.equal(checkOverlap([a, { ...b, text: '' }]).length, 0);
  assert.equal(checkOverlap([a, { ...b, textRects: [{ left: 10, top: 8, right: 12, bottom: 10 }] }]).length, 0);
  assert.equal(checkOverlap([a, { ...b, textRects: [] }]).length, 0);
  assert.equal(checkOverlap([a, { ...b, occluded: true }]).length, 0);
});

test('截断用变换后的文字矩形复核滚动尺寸，按轴容忍 1px', () => {
  const a = { ...box('a'), overflowX: 'hidden', scrollWidth: 11, contentTextRects: [{ left: 0, top: 0, right: 11, bottom: 10 }] };
  assert.equal(checkClipping(a), false);
  assert.equal(checkClipping({ ...a, scrollWidth: 12 }), false, '视觉矩形只超出 1px');
  const wide = { ...a, scrollWidth: 12, contentTextRects: [{ left: 0, top: 0, right: 12, bottom: 10 }] };
  assert.equal(checkClipping(wide), true);
  assert.equal(checkClipping({ ...wide, scrollWidth: 11 }), true, '1px 容差只用于视觉矩形，不用于缩放前预筛选');
  assert.equal(checkClipping({ ...wide, contentTextRects: [{ left: -2, top: 0, right: 8, bottom: 10 }] }), true);
  assert.equal(checkClipping({ ...a, overflowX: 'auto', scrollWidth: 20 }), false);
  assert.equal(checkClipping({ ...a, overflowY: 'clip', scrollHeight: 12, contentTextRects: [{ left: 0, top: 0, right: 10, bottom: 12 }] }), true);
  assert.equal(checkClipping({ ...a, scrollHeight: 20 }), false);
  assert.equal(checkClipping({ ...a, text: '', scrollWidth: 20 }), false);
  assert.equal(checkClipping({ ...a, visible: false, scrollWidth: 20 }), false);
  assert.equal(checkClipping({ ...wide, occluded: true }), false);
  assert.equal(checkClipping({ ...a, scrollWidth: 100, scrollHeight: 100, overflowY: 'hidden', contentTextRects: [{ left: 0, top: 0, right: 10, bottom: 10 }] }), false, '缩略图布局尺寸大，变换后的文字仍在容器里');
});

test('标题和角标只比较字形，多行之间的留白与 padding 不算重叠', () => {
  const title = { ...box('title', 0, 0, 100, 60), textRects: [{ left: 10, top: 10, right: 60, bottom: 20 }, { left: 10, top: 40, right: 60, bottom: 50 }] };
  const badge = { ...box('badge', 40, 0, 60, 40), textRects: [{ left: 50, top: 25, right: 80, bottom: 35 }] };
  assert.equal(checkOverlap([title, badge]).length, 0);
  badge.textRects[0].top = 15;
  assert.equal(checkOverlap([title, badge])[0].area, 50);
});

test('遮罩下的文字不报重叠或视口溢出，遮罩文字照常检查', () => {
  const under = { ...box('under', 95, 0), occluded: true };
  const overlay = box('overlay', 95, 0);
  const snapshot = { viewport: { width: 100, height: 80 }, document: { scrollWidth: 100, scrollHeight: 80 }, elements: [under, overlay] };
  assert.deepEqual(checkLayout(snapshot).map(i => [i.code, i.element]), [['outside-viewport', describeElement(overlay)]]);
  assert.equal(checkOverlap([under, overlay]).length, 0);
  assert.equal(checkOverlap([under, overlay, box('visible', 97, 0)]).length, 1);
});

test('字号小于 11px 才警告，隐藏文字不参与', () => {
  assert.equal(checkFontSize({ ...box('a'), fontSize: 10.99 }), true);
  assert.equal(checkFontSize({ ...box('a'), fontSize: 11 }), false);
  assert.equal(checkFontSize({ ...box('a'), fontSize: 10, visible: false }), false);
  assert.equal(checkFontSize({ ...box('a'), fontSize: 10, ownText: false }), false, '父容器字号不能冒充子元素实际字号');
});

test('整页滚动、超出视口与字号分级，滚动容器裁剪后的盒子不误报', () => {
  const snapshot = { viewport: { width: 100, height: 80 }, document: { scrollWidth: 101, scrollHeight: 80 }, elements: [box('a', 95, 0)], events: [] };
  assert.deepEqual(checkLayout(snapshot).map(x => x.code), ['page-scroll', 'outside-viewport']);
  snapshot.document.scrollWidth = 100;
  snapshot.elements[0].visibleRect = { left: 95, top: 0, right: 100, bottom: 10 };
  assert.deepEqual(checkLayout(snapshot), []);
  snapshot.elements[0].fontSize = 10;
  assert.equal(checkLayout(snapshot)[0].severity, 'warning');
});

const outline = { groups: [{ id: 'main', screens: [{ id: 'web-home', states: ['default', 'empty'] }] }] };
const sections = ['default', 'empty'].map(state => ({ screen: 'web-home', state, group: 'main' }));
test('大纲与 section 双向唯一匹配，并校验分组与 hash 的屏和状态', () => {
  assert.deepEqual(checkOutline(outline, sections, [{ target: '#screen=web-home&state=empty&auto=1' }]), []);
  for (const actual of [sections.slice(1), [...sections, sections[0]], [...sections, { screen: 'extra', state: 'default' }], [{ ...sections[0], group: 'wrong' }, sections[1]]]) {
    assert.ok(checkOutline(outline, actual).some(x => x.code === 'outline-mismatch'));
  }
  assert.equal(checkOutline(outline, sections.slice(1))[0].screen, 'web-home');
  assert.equal(checkOutline(outline, sections.slice(1))[0].state, 'default');
  assert.ok(checkOutline(outline, sections, [{ target: '#screen=missing' }]).some(x => x.code === 'missing-target'));
  assert.ok(checkOutline(outline, sections, [{ target: 'file:///sample.html#screen=web-home&state=missing' }]).some(x => x.code === 'missing-target'));
  assert.deepEqual(checkOutline(outline, sections, [{ target: '#ordinary-anchor' }]), []);
  for (const invalid of [null, {}, { groups: 1 }, { groups: [null] }, { groups: [{ id: "main", screens: [null] }] }, { groups: [] }, { groups: [{ id: 'main', screens: [{ id: 'x', states: [] }] }] }]) assert.ok(checkOutline(invalid, []).length);
  assert.ok(checkOutline({ groups: [...outline.groups, outline.groups[0]] }, sections).length);
});

test('视口与中文元素摘要稳定，不接受无效尺寸', () => {
  assert.deepEqual(parseViewports('1440x900,1280x720'), [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]);
  assert.deepEqual(viewportsForScreen('app-home', parseViewports('800x600')), [{ width: 390, height: 844 }]);
  assert.deepEqual(viewportsForScreen('web-home', parseViewports('800x600')), [{ width: 800, height: 600 }]);
  for (const value of ['', '0x900', '10x-2', '10.5x20', '800x600,', '9007199254740992x20']) assert.throws(() => parseViewports(value));
  assert.equal(describeElement({ tag: 'p', classes: ['a', 'b'], text: '一'.repeat(25) }), 'p.a.b「' + '一'.repeat(20) + '」');
});

test('CLI 参数错误和缺少 Chrome 返回 2，不监听端口且不伪造报告', () => {
  const script = fileURLToPath(new URL('../scripts/layout-check.mjs', import.meta.url));
  for (const args of [[], ['sample.html', '--viewports', 'bad'], ['sample.html', '--unknown'], ['sample.html', '--json'], ['sample.html']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, CHROME_PATH: '/nonexistent-layout-chrome' } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /布局检查无法运行/);
    assert.equal(result.stdout, '');
    if (args.length === 1) assert.match(result.stderr, /安装 Google Chrome 或 Chromium.*CHROME_PATH/);
  }
});
