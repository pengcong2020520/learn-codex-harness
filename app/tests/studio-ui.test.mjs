import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDocument } from 'htmlparser2';
import { validatorSource } from '../scripts/studio-validators.mjs';
import { validateArtifact, productId, feedbackLabel, latest, themeHash, briefDraft, createDraftSaver, packageGroups, historyGroups } from '../agents/studio/ui/model.mjs';
import { sanitizeTree, markdown } from '../agents/studio/ui/markdown.mjs';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const fixture = name => JSON.parse(read(`tests/fixtures/studio/${name}.json`));

test('Studio schema：共享契约生成文件一致，拒绝额外字段、错项目、非法推荐与恶意令牌', () => {
  assert.equal(read('agents/studio/ui/vendor/validators.mjs'), validatorSource());
  for (const [kind, name] of [['clarify', 'clarify-r1'], ['themes', 'themes-r1'], ['structure-changes', 'structure-changes-v1'], ['package-check', 'qa/package-check']]) {
    assert.doesNotThrow(() => validateArtifact(kind, fixture(name), 'task-helper'));
    assert.throws(() => validateArtifact(kind, { ...fixture(name), injected: true }, 'task-helper'));
    assert.throws(() => validateArtifact(kind, fixture(name), 'other'));
  }
  const value = fixture('clarify-r1'); value.questions[0].options[1].recommended = true;
  assert.throws(() => validateArtifact('clarify', value, 'task-helper'));
  value.questions[0].options[1].recommended = false; value.questions.push(value.questions[0]);
  assert.throws(() => validateArtifact('clarify', value, 'task-helper'));
  const tokens = fixture('themes-r1'); tokens.styles[0].tokens['--radius-sm'] = 'url(https://example.com)';
  assert.throws(() => validateArtifact('themes', tokens, 'task-helper'));
});

test('Studio 产品 id 与数字版本：中文使用时间后备，合法英文规范化，拒绝路径注入', () => {
  assert.equal(productId('Task Helper', 123), 'task-helper');
  assert.equal(productId('事项助手', 123), 'agent-123');
  for (const name of ['123', '../../危险', 'A'.repeat(100), '', 'Task_Helper']) assert.match(productId(name, 123), /^[a-z][a-z0-9-]{0,47}$/);
  assert.equal(latest(['prd-v2.md', 'prd-v10.md', 'prd-v9.md'], 'prd', 'md'), 'prd-v10.md');
});

test('Studio feedback：只按服务端 mode 展示结果', () => {
  assert.equal(feedbackLabel('steer'), '已加入当前生成');
  assert.equal(feedbackLabel('revise'), '正在按你的意见重做');
  assert.equal(feedbackLabel('queued'), '意见已排队，将在当前步骤执行');
  assert.throws(() => feedbackLabel('invented'));
});

test('Studio 主题 hash 使用 UTF-8 完整令牌，资料卡保留用户来源与附件路径', () => {
  const theme = fixture('theme-v1');
  const hash = themeHash(theme.style, theme.theme);
  const raw = new URLSearchParams(hash).get('theme');
  assert.deepEqual(JSON.parse(Buffer.from(raw, 'base64url')), { style: theme.style, theme: theme.theme });
  const draft = briefDraft({ name: '事项助手', audience: '个人', scenarios: '早晨', coreTasks: '整理、保存' }, 'task-helper', ['inputs/uploads/a.png']);
  assert.deepEqual(draft.fields.audienceAndScenarios.value, ['个人', '早晨']);
  assert.deepEqual(draft.fields.references.value, ['inputs/uploads/a.png']);
  assert.equal(draft.fields.name.source, 'user'); assert.equal(draft.clarificationRounds, 0);
});

test('Studio 草稿失败不自动重发，后续输入仍保留；串行保存避免旧输入覆盖', async () => {
  const calls = []; let reject, release;
  const saver = createDraftSaver(async value => { calls.push(value); await new Promise((yes, no) => { release = yes; reject = no; }); });
  const first = saver.save({ name: '一' }); await Promise.resolve();
  saver.stage({ name: '二' }); reject(Error('离线')); await assert.rejects(first, /离线/);
  assert.equal(saver.blocked, true); assert.deepEqual(saver.value, { name: '二' }); assert.equal(calls.length, 1);
  const retry = saver.save(saver.value); await Promise.resolve(); release(); await retry;
  assert.deepEqual(calls, [{ name: '一' }, { name: '二' }]);
});

test('Studio vendor：marked 固定版本与依赖逐字节一致', () => {
  assert.equal(JSON.parse(read('package.json')).devDependencies.marked, '17.0.6');
  assert.equal(read('agents/studio/ui/vendor/marked.mjs'), read('node_modules/marked/lib/marked.esm.js'));
});

// 离线使用 htmlparser2 的真实 HTML 解析树；DOMParser 入口另由浏览器测试覆盖。
test('Studio Markdown 白名单：脚本、事件、协议混淆、SVG、图片与样式均不可进入输出', () => {
  function adapt(node) {
    return { nodeType: node.type === 'text' ? 3 : 1, nodeValue: node.data, tagName: node.name?.toUpperCase(),
      getAttribute: name => node.attribs?.[name] ?? null, childNodes: (node.children || []).map(adapt) };
  }
  const created = [];
  const document = { createDocumentFragment: () => ({ children: [], append(...children) { this.children.push(...children); } }),
    createTextNode: text => ({ text }), createElement: tag => { const node = { tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...children) { this.children.push(...children); } }; created.push(node); return node; } };
  const tree = parseDocument('<script>alert(1)</script><p onclick="x()" style="color:red">内容<a href="java&#x73;cript:alert(1)">危险</a><a href="https://example.com" onmouseover="x()">安全</a><a href="data:text/html,x">data</a><svg onload="x()"><a href="https://example.com">隐藏</a></svg><img src=x onerror=x()></p>');
  const clean = sanitizeTree(adapt(tree), document);
  assert.ok(JSON.stringify(clean).includes('内容'));
  assert.ok(created.every(node => ['p', 'a'].includes(node.tag)));
  assert.equal(created.filter(node => node.attrs.href).length, 1);
  assert.equal(created.find(node => node.attrs.href).attrs.href, 'https://example.com/');
  assert.doesNotMatch(JSON.stringify(clean), /onclick|onload|javascript:|alert\(|onerror|color:red/);
});

test('Studio 静态 CSP：无内联脚本、内联样式或事件，所有自带资源同源', () => {
  const tree = parseDocument(read('agents/studio/ui/index.html'));
  const visit = node => {
    assert.notEqual(node.name, 'style');
    if (node.name === 'script') { assert.ok(node.attribs.src); assert.equal(node.children.length, 0); }
    for (const [key, value] of Object.entries(node.attribs || {})) {
      assert.ok(key !== 'style' && !key.startsWith('on'));
      if (['src', 'href'].includes(key)) assert.ok(value.startsWith('/app/'));
    }
    for (const child of node.children || []) visit(child);
  }; visit(tree);
  assert.match(read('agents/studio/ui/styles.css'), /prefers-color-scheme: dark/);
  assert.doesNotMatch(read('agents/studio/ui/styles.css'), /font-size:\s*(?:[1-9]|1[01])px/);
});

test('Studio 草稿：前一次失败后，已排队的自动保存也必须停止，不能悄悄重发', async () => {
  let reject;
  const calls = [];
  const saver = createDraftSaver(async value => { calls.push(value); await new Promise((yes, no) => { reject = no; }); });
  const first = saver.save({ text: '第一份' }); await Promise.resolve();
  const second = saver.save({ text: '用户继续输入' });
  const firstRejected = assert.rejects(first, /网络失败/), secondRejected = assert.rejects(second, /手动重试/);
  reject(Error('网络失败')); await Promise.all([firstRejected, secondRejected]);
  assert.equal(calls.length, 1); assert.deepEqual(saver.value, { text: '用户继续输入' });
});

test('Studio 原型示例：默认 CSS 与 theme-v1 的全部令牌一致，包内镜像保持一致', () => {
  const theme = fixture('theme-v1');
  for (const name of ['prototype-v1.html', 'prototype-v2.html']) {
    const html = read(`tests/fixtures/studio/${name}`);
    const css = html.match(/:root\{([^}]*)\}/)[1];
    for (const [key, value] of Object.entries({ ...theme.style, ...theme.theme })) assert.ok(css.includes(`${key}:${value};`), key);
    assert.equal(html, read(`tests/fixtures/studio/package-v1/design/${name}`));
    assert.match(html, /background:var\(--accent\)/);
  }
});

test('Studio 路径校验：项目目录不可越界，拒绝绝对路径、编码点段及协议', async () => {
  const { projectPath } = await import('../agents/studio/ui/model.mjs');
  const project = { id: 'task-helper', name: '事项助手' };
  assert.equal(projectPath(project, 'package-v1/PROMPT.md'), 'outputs/design/task-helper/package-v1/PROMPT.md');
  for (const relative of ['../private.md', '/private.md', 'a/../private.md', 'a//b.md', 'a/%2e%2e/b.md', 'https://example.com', 'a\\b.md']) assert.throws(() => projectPath(project, relative));
});


test('Studio 回执：revise 按触发区分；steer 与 queued 保持服务端通用含义', () => {
  const triggers = [['提交第 2 轮澄清答案\n补充', '已提交第 2 轮答案'], ['换一换：风格', '正在换一组风格'], ['换一换：主题', '正在换一组主题'], ['按结构改动决定生成', '正在按你的决定生成']];
  for (const [trigger, expected] of triggers) {
    assert.equal(feedbackLabel('revise', trigger), expected);
    assert.equal(feedbackLabel('steer', trigger), '已加入当前生成');
    assert.equal(feedbackLabel('queued', trigger), '意见已排队，将在当前步骤执行');
  }
});

test('Studio 代码包：设计记录折叠计数，其余按所在目录分组且文件不丢失', () => {
  const files = fixture('package-v1/manifest').files, groups = packageGroups(files);
  assert.equal(groups.flatMap(group => group.files).length, files.length);
  assert.equal(groups.find(group => group.directory === 'design/').files.length, files.filter(file => file.path.startsWith('design/')).length);
  assert.deepEqual(groups.find(group => group.directory === 'agent/ui/').files, ['app.js', 'index.html', 'styles.css']);
});

test('Studio 历史：阶段与时间倒序、轮次或版本标签、此前阶段最新版本已确认', () => {
  const entries = [
    { name: 'prd-v1.md', updatedAt: '2026-11-15T12:01:00Z' }, { name: 'prd-v2.md', updatedAt: '2026-11-15T12:02:00Z' },
    { name: 'themes-r2.json', updatedAt: '2026-11-15T12:04:00Z' }, { name: 'clarify-r1.json', updatedAt: '2026-11-15T12:00:00Z' },
  ];
  const groups = historyGroups(entries, 3);
  assert.deepEqual(groups.map(group => group.step), [3, 1, 0]);
  assert.deepEqual(groups[1].versions.map(version => [version.name, version.label, version.confirmed]), [['prd-v2.md', 'v2', true], ['prd-v1.md', 'v1', false]]);
  assert.equal(groups[0].versions[0].label, '第 2 轮'); assert.equal(groups[0].versions[0].confirmed, false);
  assert.match(groups[0].versions[0].time, /^\d{2}:\d{2}$/);
});

test('Studio Markdown：原始 HTML 转为文字，独立段落保留正常 Markdown', () => {
  const adapt = node => ({ nodeType: node.type === 'text' ? 3 : 1, nodeValue: node.data, tagName: node.name?.toUpperCase(),
    getAttribute: name => node.attribs?.[name] ?? null, childNodes: (node.children || []).map(adapt) });
  const document = { createDocumentFragment: () => ({ children: [], append(...nodes) { this.children.push(...nodes); } }),
    createTextNode: text => ({ text }), createElement: tag => ({ tag, attrs: {}, children: [], setAttribute(k,v) { this.attrs[k]=v; }, append(...nodes) { this.children.push(...nodes); } }) };
  class Parser { parseFromString(html) { return { body: adapt(parseDocument(html)) }; } }
  const result = markdown('<script>alert(1)</script><img src=x onerror=x()>正文\n\n**正常** [危险](javascript:alert(1))', document, Parser);
  const nodes = [], visit = node => { nodes.push(node); for (const child of node.children || []) visit(child); }; visit(result);
  assert.ok(nodes.some(node => node.text?.includes('<script>')));
  assert.ok(nodes.some(node => node.text?.includes('正文')));
  assert.ok(nodes.some(node => node.tag === 'strong' && node.children[0].text === '正常'));
  assert.ok(nodes.every(node => !['script', 'img'].includes(node.tag)));
  assert.ok(nodes.every(node => !Object.keys(node.attrs || {}).some(name => name.startsWith('on')) && !node.attrs?.href?.startsWith('javascript:')));
});

test('Studio 夹具：独立目录嵌入时隐藏，包内镜像与契约一致', () => {
  for (const name of ['wireframe-v1.html', 'theme-sample-v1.html', 'theme-sample-v2.html', 'theme-sample-v3.html', 'prototype-v1.html', 'prototype-v2.html']) {
    const html = read(`tests/fixtures/studio/${name}`);
    assert.match(html, /window.top !== window.self/);
    assert.match(html, /querySelector\('header details'\)\.hidden=true/);
    assert.equal(html, read(`tests/fixtures/studio/package-v1/design/${name}`));
  }
  const contract = read('agents/studio/skills/studio-contract/SKILL.md');
  assert.match(contract, /window.top !== window.self/);
  assert.match(contract, /信息已足够，停止补充提问.*final=true.*questions 为空/);
});
