import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const names = ["agent-design-flow", "agent-brief", "prd-spec", "lofi-wireframe", "theme-factory", "frontend-design", "prototype-builder", "flow-walkthrough", "design-handoff", "layout-qa"];
const claudeRoot = path.join(root, '.claude/skills');
const codexRoot = path.join(root, '.agents/skills');
const read = name => fs.readFileSync(path.join(claudeRoot, name, 'SKILL.md'), 'utf8');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false, `Skill 不应含符号链接：${entry.name}`);
    return entry.isDirectory() ? files(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name];
  }).sort();
}
for (const name of names) {
  test(`设计 Skill ${name} 两家所有文件逐字节相同`, () => {
    const left = path.join(codexRoot, name), right = path.join(claudeRoot, name);
    assert.deepEqual(files(left), files(right));
    for (const file of files(right)) assert.ok(fs.readFileSync(path.join(left, file)).equals(fs.readFileSync(path.join(right, file))), `${name}/${file}`);
  });
  test(`设计 Skill ${name} 只有 name 和 description 且相对资源可解析`, () => {
    const source = read(name);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source);
    assert.ok(frontmatter);
    const lines = frontmatter[1].split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `name: ${name}`);
    assert.match(lines[1], /^description: .+不用于.+/);
    for (const [, target] of source.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(target) || target.startsWith('#')) continue;
      assert.ok(fs.existsSync(path.resolve(claudeRoot, name, target.split('#')[0])), `${name} 引用缺失：${target}`);
    }
  });
}

// 固定用户原句，避免改写提示词时悄悄丢掉要求；不依赖本机参考资料目录。
const requirements = {
  "lofi-wireframe": [
    "1. 只做低保真，不做正式 UI。使用黑白灰、基础框线和图片占位块，只表达信息层级、核心文案、按钮位置和页面状态；",
    "2. 按照用户真实使用产品的先后顺序分组，把 PRD 中涉及的核心页面和关键状态全部平铺在同一页，让我可以从头到尾检查整个流程；",
    "3. 每一屏都标清页面名称、它在流程里的位置、用户可以执行的操作，以及操作之后会进入哪个页面或状态；",
    "4. 除了正常流程，还要补齐 PRD 中涉及的首次使用、权限申请、加载中、无数据、失败和异常恢复等状态；",
    "5. 不要擅自增加 PRD 里没有的功能。PRD 中没有说明清楚的地方单独标成「待确认」，不要自行补全；",
    "6. 所有内容放在一个 HTML 文件里，打开文件就能完整查看。"
  ],
  "flow-walkthrough": [
    "1. 按照用户的实际使用流程分组。每组一个小标题，从上往下看完就是一次完整的产品体验；",
    "2. 除了正常页面，还要覆盖重要的流程分支，以及不同的页面状态；",
    "3. 每一屏都要标注页面名称、当前状态和复现方式，并提供一个反馈输入框，以及「可以」「待改」「阻塞」三个快捷标记；",
    "4. 每一组最后增加一个流程反馈输入框，用来记录反馈；",
    "5. 所有反馈输入后自动保存在本地；",
    "6. 支持导出 Markdown、导出 JSON，可以直接交给 AI 修改；",
    "7. 在新一轮走查页中保留上一轮的反馈原话，并给改动过的页面加上标记，方便逐条回归验证。",
    "先不要开始截图。先列出你准备覆盖的流程分组、页面和状态，等我确认之后再执行。"
  ]
};
for (const [name, lines] of Object.entries(requirements)) {
  for (const [index, line] of lines.entries()) test(`${name} 保留用户原文第 ${index + 1} 项`, () => assert.ok(read(name).includes(line), line));
}

// 摘自任务随附的官方文件，保护许可证、预设与脚本原始字节。
const upstream = {
  "theme-factory/themes/arctic-frost.md": "868a75a8fb5b2a61d0f0ab87c437fe632d3cbab6371c418f06aa2816ac109ae0",
  "theme-factory/themes/botanical-garden.md": "222cb8e7496abc9b75b29453c809fb9839e7e4b01fa45deecdd896b38d087765",
  "theme-factory/themes/desert-rose.md": "bd065b8629be3b64655183927e248e3d892a27b8d184b009cfba89c96102744f",
  "theme-factory/themes/forest-canopy.md": "ecb722efa24688e808b5bf323c334ca2349e989cfddd72ce8400ce5d4c4bd3e7",
  "theme-factory/themes/golden-hour.md": "3444a00df971d3c2f06b665e21a2e9eb5d7d7d6f6281f2758773b8345776a139",
  "theme-factory/themes/midnight-galaxy.md": "0e134c4c0324df41e34ac314269aa6829cd378cf3c304b31858d0cd158d2f944",
  "theme-factory/themes/modern-minimalist.md": "b8bc572b75948d4df69c401af703b9262ed6820a3ceb270da30a529e92763614",
  "theme-factory/themes/ocean-depths.md": "a7ad8eec85341dbfcb2665da827a4b6a4baee08ab3335ac02421f18e6b46b2e2",
  "theme-factory/themes/sunset-boulevard.md": "658af11ab04be4923692571081ffb42a428141ae537703117b9236d9f8ee22a3",
  "theme-factory/themes/tech-innovation.md": "183648163026dd5eeba3df5effa335b55ba333c3ee1fe215278605e55f40a52a",
  "prototype-builder/scripts/bundle-artifact.sh": "abf0e480bf6585b56fab8526a407dfb7dc740812bddd70c636e1e8f3df5f9618",
  "prototype-builder/scripts/init-artifact.sh": "355e5dd4382aaaee91f01f1627eaeab30b2676ffa8d9b3ec328a1ae450ebccaa",
  "prototype-builder/scripts/shadcn-components.tar.gz": "1296f069e825de7933de7e8ac63672495cacce3f88f2dc45554dbcddbcbca60f",
  "theme-factory/LICENSE.txt": "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362",
  "frontend-design/LICENSE.txt": "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594",
  "prototype-builder/LICENSE.txt": "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362",
  "prd-spec/LICENSE-spec-kit.txt": "2510b446bc1f0cf9702453075d20cd88631e20e5642658edb7325d9c1eb534f7"
};
test('官方预设、脚本与许可证保留原始字节且目录完整', () => {
  for (const [file, digest] of Object.entries(upstream)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(claudeRoot, file))).digest('hex'), digest, file);
  }
  assert.deepEqual(files(path.join(claudeRoot, 'theme-factory/themes')), Object.keys(upstream).filter(file => file.startsWith('theme-factory/themes/')).map(file => file.slice('theme-factory/themes/'.length)).sort());
  assert.deepEqual(files(path.join(claudeRoot, 'prototype-builder/scripts')), Object.keys(upstream).filter(file => file.startsWith('prototype-builder/scripts/')).map(file => file.slice('prototype-builder/scripts/'.length)).sort());
  assert.equal(fs.existsSync(path.join(claudeRoot, 'theme-factory/theme-showcase.pdf')), false);
});
for (const [name, source] of [['theme-factory', 'theme-factory'], ['frontend-design', 'frontend-design'], ['prototype-builder', 'web-artifacts-builder']]) {
  test(`${name} 声明官方来源、许可证与修改范围`, () => {
    const notice = fs.readFileSync(path.join(claudeRoot, name, 'NOTICE.md'), 'utf8');
    for (const term of [`anthropics/skills`, source, 'Apache-2.0', '2026-11-14', '修改']) assert.ok(notice.includes(term), term);
  });
}
test('PRD 声明 spec-kit 来源和 MIT 许可证', () => {
  for (const term of ['github/spec-kit', 'spec-template', 'MIT', 'LICENSE-spec-kit.txt']) assert.ok(read('prd-spec').includes(term), term);
});

const artifacts = {
  'agent-brief': ['brief-v1.md'],
  'prd-spec': ['brief-v1.md', 'prd-v1.md'],
  'lofi-wireframe': ['prd-v1.md', 'wireframe-v1.html'],
  'theme-factory': ['wireframe-v1.html', 'themes-r1.json', 'theme-sample-v1.html', 'theme-v1.json'],
  'frontend-design': ['prd-v1.md', 'wireframe-v1.html', 'theme-v1.json', 'prototype-v1.html', 'structure-changes-v1.json'],
  'prototype-builder': ['prototype-v1.html'],
  'design-handoff': ['brief-v1.md', 'prd-v1.md', 'wireframe-v1.html', 'themes-r1.json', 'theme-sample-v1.html', 'theme-v1.json', 'prototype-v1.html', 'package-v1/'],
};
test('各阶段文件名与总流程产物约定一致', () => {
  const flow = read('agent-design-flow');
  for (const [name, terms] of Object.entries(artifacts)) {
    assert.ok(read(name).includes('../agent-design-flow/SKILL.md'), name);
    for (const term of terms) {
      assert.ok(flow.includes(term), `总流程缺 ${term}`);
      assert.ok(read(name).includes(term), `${name} 缺 ${term}`);
    }
  }
});
test('设计 HTML 共用屏幕定位、大纲和状态词表', () => {
  for (const name of ['agent-design-flow', 'lofi-wireframe', 'theme-factory', 'frontend-design', 'prototype-builder']) {
    for (const term of ['data-screen', 'data-state', 'data-group', '#screen=<id>&state=<状态>', 'design-outline', 'default、first-use、permission、loading、empty、error、recovery']) assert.ok(read(name).includes(term), `${name} 缺 ${term}`);
  }
});
function jsonBlocks(name) {
  return [...read(name).matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
}
test('资料卡、主题、走查与交付的 JSON 示例合法且引用衔接', () => {
  for (const name of ['agent-design-flow', 'agent-brief', 'theme-factory', 'flow-walkthrough', 'design-handoff']) assert.ok(jsonBlocks(name).length, name);
  const [plan, round] = jsonBlocks('flow-walkthrough');
  assert.equal(round.plan, 'walkthrough-plan-v1.json');
  assert.equal(plan.schemaVersion, round.schemaVersion);
  assert.equal(plan.projectId, round.projectId);
  assert.equal(plan.groups[0].screens[0].id, round.groups[0].screens[0].id);
  assert.deepEqual(plan.groups[0].screens[0].states, round.groups[0].screens[0].states.map(state => state.state));
  for (const state of round.groups[0].screens[0].states) {
    assert.equal(round.mode, 'product');
    assert.ok('screenshot' in state && 'diagnostics' in state && 'unavailableReason' in state);
    assert.equal('preview' in state, false, '真实产品巡查不使用原型 iframe');
    assert.ok(['可以', '待改', '阻塞', null].includes(state.feedback.mark));
    for (const key of ['previousFeedback', 'changeEvidence', 'changeStatus', 'reproduce']) assert.ok(key in state, key);
  }
  const [manifest] = jsonBlocks('design-handoff');
  for (const artifact of manifest.artifacts) for (const key of ['path', 'version', 'confirmedAt', 'confirmedBy']) assert.ok(key in artifact, key);
});


test('代码与落地包包含完整目录和带哈希、确认及落地信息的 manifest', () => {
  const handoff = read('design-handoff'), flow = read('agent-design-flow');
  for (const term of ['package-v1/', 'manifest.json', 'agent/', 'ui/', 'design/', 'DEPLOY.md', 'PROMPT.md']) assert.ok(handoff.includes(term), term);
  assert.ok(flow.includes('7 代码与落地'));
  assert.ok(flow.includes('package-v1/…'));
  for (const source of [handoff, flow]) assert.ok(!source.includes('handoff-v'));
  const [manifest] = jsonBlocks('design-handoff');
  for (const key of ['schemaVersion', 'projectId', 'productId', 'agentId', 'packageVersion', 'createdAt', 'confirmation', 'files', 'artifacts', 'scaffold', 'landing']) assert.ok(key in manifest, key);
  assert.ok(manifest.scaffold.minimumVersion);
  assert.ok(manifest.scaffold.requiredCapabilities.includes('K2'));
  assert.ok(manifest.scaffold.requiredCapabilities.includes('K4'));
  assert.ok(manifest.files.length);
  for (const file of manifest.files) {
    assert.ok(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
  for (const artifact of manifest.artifacts) {
    assert.ok(manifest.files.some(file => file.path === artifact.path));
    for (const key of ['version', 'confirmedAt', 'confirmedBy', 'source', 'inputs']) assert.ok(key in artifact, key);
  }
  assert.equal(manifest.landing.agentSource, 'agent/');
  assert.equal(manifest.landing.uiSource, 'agent/ui/');
  assert.equal(manifest.landing.designSource, 'design/');
  assert.equal(manifest.landing.replaceDefaultUi, true);
  assert.equal(manifest.landing.removeStudio, true);
  assert.equal(manifest.landing.rebuild, true);
  assert.ok(manifest.landing.checks.includes('agent:check'));
});

test('落地包禁止宿主机脚本并说明固定命令、部署与真实产品巡查入口', () => {
  const handoff = read('design-handoff'), flow = read('agent-design-flow');
  for (const term of ['代码包不含宿主机脚本', '不得使用内联脚本和样式', '不得引用外部资源', '按 K2 约定', '示例数据不能写死', '需要开发', 'docker compose run --rm land', 'npm run design:land', 'npm run deploy', 'deploy/install.sh', 'app/agents/<id>/', 'app/design/<产品 id>/', '先读 AGENTS.md', 'build-from-design', 'deploy/walkthrough.sh', 'flow-walkthrough', '真实产品巡查', 'production:check']) assert.ok(handoff.includes(term), term);
  for (const term of ['只有管理员能进入工作室', '一份脚手架只有一个设计项目', '生成代码包，不修改服务端代码', 'app/design/<产品 id>/']) assert.ok(flow.includes(term), term);
});

test('落地前端接口表的方法和路径对应现有 HTTP 路由', () => {
  const handoff = read('design-handoff');
  const routes = fs.readFileSync(path.join(root, 'app/server/modules/http/index.mjs'), 'utf8');
  for (const route of ['GET /sessions', 'POST /sessions', 'POST /sessions/resume', 'GET /state', 'POST /messages', 'GET /events', 'POST /tasks/confirm', 'POST /tasks/revise', 'POST /tasks/cancel', 'POST /queue/continue', 'GET /workspace', 'GET /workspace/read', 'POST /previews', 'PUT /workspace/files']) {
    assert.ok(handoff.includes(route), `接口表缺 ${route}`);
    assert.ok(routes.includes(`'${route}'`) || routes.includes(`"${route}"`), `源码缺 ${route}`);
  }
  assert.ok(handoff.includes('GET /preview/<签名值>'));
  assert.ok(routes.includes("request.method === 'GET' && pathname.startsWith('/preview/')"));
});

// 固定评审形成的跨阶段契约；用户原文仍由上面的逐条断言保护。
const reviewContracts = {
  'agent-design-flow': ['一问一答', '只给摘要', '思考中', '快捷回复', '自然语言', '`steer`', '`revise`', '资料卡、澄清', '不显示聊天', '最多 3 轮', '表单', '每轮最多 5 题', '每题带选项和推荐项', '低保真、主题样页、高保真', 'layout-qa', 'themes-r1.json', 'theme-sample-v1.html'],
  'lofi-wireframe': ['打开即是产品的一屏', '一屏原则', '预览不使用标签条', '醒目的左侧目录', '默认收起的评审切换器', '悬停提示', '平铺查看作为可选模式', '&auto=1', '约 2 秒', '目录或直接 hash', 'layout-qa'],
  'frontend-design': ['一屏原则', '预览区和聊天区尽量占满', '不放说明条、操作条或标注框', '`<`、`>`', 'layout-qa'],
  'theme-factory': ['两道三选一', '视觉风格', '配色与字体', '完全不同', '各自带“换一换”', '新选项不与已展示过的重复', '进入本阶段前，在聊天里询问', '多张和拖拽上传', 'themes-r<n>.json', 'theme-sample-v<n>.html', '`theme=`', 'base64url', 'JSON 令牌', 'CSS 变量', 'hashchange', '即时换肤', '两道题都选定后', '只有一道题选定时不能写', 'theme-v<n>.json', 'layout-qa'],
  'flow-walkthrough': ['没有聊天区', '左侧按流程分组列目录', '真实截图（可放大）', '复现方式', '可以 / 待改 / 阻塞', '每组末尾另有流程反馈', '底部显示本轮计数与保存状态', '导出 Markdown', '导出 JSON', '确认本轮巡查通过', '不放“按反馈修复”', '截图上不叠加任何标签或按钮', '计划变动新建版本重新确认', 'localStorage', 'unmatchedPrevious', '前端', '后端', '整体', 'deploy/walkthrough.sh', 'production:check'],
  'prototype-builder': ['主题令牌通过 CSS 变量注入', '所有 `(screen,state)` 都能用 hash 定位', 'layout-qa'],
  'layout-qa': ['任何线框、主题样页、高保真原型', '先通过布局校验才能给用户看', '`check_design`', 'K3a-2', 'node app/scripts/layout-check.mjs', '最多自动修 2 轮', '不能声称已通过', '长文本截断', '定宽容器溢出', '绝对定位重叠', '区域内滚动', 'CHROME_PATH', '返回 1', '返回 2'],
};
for (const [name, terms] of Object.entries(reviewContracts)) {
  test(`设计 Skill ${name} 保留评审约定`, () => {
    for (const term of terms) assert.ok(read(name).includes(term), `${name} 缺 ${term}`);
  });
}
test('设计 Skill 不保留冲突的默认平铺与三套并排产物约定', () => {
  for (const name of ['agent-design-flow', 'lofi-wireframe', 'theme-factory', 'design-handoff']) {
    for (const term of ['themes-r1.html', 'themes-r<n>.html', '无定位 hash 时按组和顺序平铺', '无定位时三套并排', '每屏统一标注']) assert.ok(!read(name).includes(term), `${name} 仍含冲突约定 ${term}`);
  }
});

test('巡查仅本机开发后执行，工作室总流程和交付不再依赖走查产物', () => {
  const flow = read('agent-design-flow'), handoff = read('design-handoff'), walkthrough = read('flow-walkthrough');
  for (const source of [flow, handoff]) {
    assert.doesNotMatch(source, /walkthrough-(?:plan|v1|r1)/);
    assert.doesNotMatch(source, /原型和走查均已/);
  }
  assert.doesNotMatch(walkthrough, /iframe|原型走查|实时预览缩略图/);
  for (const term of ['开发完成', '部署之前', '用户本机', '先列计划', '等确认', 'deploy/walkthrough.sh', '反馈原话', '已修改']) assert.ok(walkthrough.includes(term), term);
  const instructions = handoff.slice(handoff.indexOf('## PROMPT.md'));
  let previous = -1;
  for (const term of ['1. 落地', '2. 按设计开发', '3. 检查与构建', '4. 本机运行', '5. 真实产品巡查', '6. 按反馈修复', '7. 下一轮回归', '8. 生产检查', '9. 部署']) {
    const index = instructions.indexOf(term); assert.ok(index > previous, term); previous = index;
  }
});

test('lofi-wireframe 用户提示词完整段落逐字节保留', () => {
  const source = read('lofi-wireframe');
  const part = source.slice(source.indexOf('## 用户提示词原文'));
  const prompt = part.slice(0, part.indexOf('\n## ', 4));
  assert.equal(createHash('sha256').update(prompt).digest('hex'), '9414dddbdf3b0e909a4baff560d5d8888bdd6b04d0ce71c8a5cec79165be3da2');
});

test('flow-walkthrough 用户提示词完整段落逐字节保留', () => {
  const source = read('flow-walkthrough');
  const part = source.slice(source.indexOf('## 用户提示词原文'));
  const prompt = part.slice(0, part.indexOf('\n## ', 4));
  assert.equal(createHash('sha256').update(prompt).digest('hex'), '49f449dc4c56c9d4e50e8dd1cf8c73b1698b00d155216e860a7cba176a2d45ee');
});
