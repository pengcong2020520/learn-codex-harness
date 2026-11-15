import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { Parser } from 'htmlparser2';
import { checkAgent } from '../scripts/agent-check.mjs';
import { validateDefinition } from '../server/modules/agents/schema.mjs';
import { checkAgentPackage } from '../server/modules/design/package.mjs';
import { createFileTools } from '../server/modules/data/files.mjs';
import { tempRoot } from './helpers.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const studio = path.join(root, 'app/agents/studio');
const fixtures = path.join(root, 'app/tests/fixtures/studio');
const contract = path.join(studio, 'skills/studio-contract');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const definition = read(path.join(studio, 'agent.json'));
const role = fs.readFileSync(path.join(studio, 'role.md'), 'utf8');
const steps = ['clarify', 'prd', 'lofi', 'theme', 'hifi', 'package'];
const skills = ['agent-design-flow', 'agent-brief', 'prd-spec', 'lofi-wireframe', 'theme-factory', 'frontend-design', 'prototype-builder', 'design-handoff', 'layout-qa'];
const ajv = new Ajv({ strict: true, allErrors: true });
const schemas = fs.readdirSync(path.join(contract, 'schemas')).map(file => read(path.join(contract, 'schemas', file)));
for (const schema of schemas) ajv.addSchema(schema);
const validator = name => ajv.getSchema(`https://example.com/studio/${name}.schema.json`);
const valid = (name, data) => { const validate = validator(name); assert.equal(validate(data), true, JSON.stringify(validate.errors)); };
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name];
  }).sort();
}

test('工作室 Agent 静态检查只有资料未部署类建议，六步完整且权限最小化', () => {
  const rows = checkAgent('agents/studio/agent.json', { root: path.join(root, 'app') });
  assert.deepEqual(rows.filter(row => row.level === 'error'), []);
  assert.ok(rows.filter(row => row.level === 'warning').every(row => /尚未部署资料/.test(row.detail)), JSON.stringify(rows));
  assert.equal(definition.agent.id, 'studio');
  assert.equal(definition.agent.name, 'Agent 设计工作室');
  assert.deepEqual(definition.agent.ui, { entry: 'ui/index.html', title: 'Agent 设计工作室' });
  assert.deepEqual(definition.agent.tools.allow, ['list_files', 'read_file', 'write_file', 'skill_read', 'check_design', 'check_agent_package', 'build_prototype']);
  assert.deepEqual(definition.agent.outputs.formats, ['md', 'json', 'html', 'js', 'css']);
  assert.equal(definition.agent.outputs.writeMode, 'create-only');
  assert.deepEqual(definition.agent.outputs.requiredChecks, ['file-exists', 'format']);
  assert.deepEqual(definition.agent.skills.map(s => s.id), [...skills, 'studio-contract']);
  assert.ok(definition.agent.skills.every(s => s.required));
  const [workflow] = definition.agent.workflows;
  assert.equal(definition.agent.workflows.length, 1);
  assert.deepEqual([workflow.id, workflow.interactive, workflow.access, workflow.single], ['design', true, 'admin', true]);
  assert.deepEqual(workflow.steps.map(s => s.id), steps);
  assert.deepEqual(workflow.steps.map(s => s.confirm), [true, true, true, true, true, false]);
  for (const step of workflow.steps) {
    assert.deepEqual(step.writes, ['outputs/design']);
    assert.deepEqual(step.checks, ['file-exists', 'format']);
    assert.equal(step.needs, undefined);
    assert.ok(step.goal.length > 500, `${step.id} 必须有完整提示词`);
    assert.ok(step.goal.length <= 4000);
    assert.match(step.goal, /^目标：[^\n]+\n按 role\.md 的通用做法读取输入与记录版本。/);
    for (const term of ['skill_read', '一两句']) assert.ok(step.goal.includes(term), `${step.id}: ${term}`);
    for (const term of ['inputs/drafts/project.json', 'inputs/drafts/brief.json', 'list_files', 'read_file', 'write_file', 'decisions-v<n>.json', 'steer', 'revise']) assert.ok(role.includes(term), term);
  }
  assert.match(fs.readFileSync(path.join(studio, 'ui/index.html'), 'utf8'), /type="module" src="\/app\/app.mjs"/);
});

test('完整 goal 独立支持 4000 字符与六步边界，其他短文本仍限 500', () => {
  const value = structuredClone(definition);
  value.agent.workflows[0].steps[0].goal = '中'.repeat(4000);
  assert.doesNotThrow(() => validateDefinition(value));
  value.agent.workflows[0].steps[0].goal += '中';
  assert.throws(() => validateDefinition(value), /goal/);
  value.agent.workflows[0].steps[0].goal = '目标';
  value.agent.name = '中'.repeat(500);
  value.agent.instructions = 'a'.repeat(500);
  assert.doesNotThrow(() => validateDefinition(value));
  value.agent.instructions += 'a';
  assert.throws(() => validateDefinition(value), /instructions/);
  value.agent.instructions = 'role.md';
  value.agent.name = '中'.repeat(501);
  assert.throws(() => validateDefinition(value), /name/);
  value.agent.name = '测试';
  value.agent.workflows[0].steps.push({ id: 'extra', goal: '不能增加第七步' });
  assert.throws(() => validateDefinition(value), /steps/);
});

for (const name of skills) test(`工作室运行时 ${name} 除追加节外与同步原件逐字节一致（含全部携带文本资源）`, () => {
  const source = path.join(root, '.agents/skills', name), target = path.join(studio, 'skills', name);
  const carried = files(source).filter(file => !file.startsWith('scripts/'));
  assert.deepEqual(carried, files(target));
  for (const file of carried) {
    const original = fs.readFileSync(path.join(source, file));
    const copy = fs.readFileSync(path.join(target, file));
    if (file !== 'SKILL.md') assert.deepEqual(copy, original, `${name}/${file}`);
    else {
      assert.deepEqual(copy.subarray(0, original.length), original, name);
      const appended = copy.subarray(original.length).toString();
      assert.ok(appended.startsWith('\n## 在工作室运行时\n'), name);
      for (const term of ['check_design', 'inputs/drafts/', 'build_prototype', '简单方式', '脚本与模板归档不随运行时副本携带', '运行时不执行脚本']) assert.ok(appended.includes(term));
      assert.equal((appended.match(/^## 在工作室运行时$/gm) || []).length, 1);
      if (name === 'design-handoff') {
        assert.ok(appended.includes('只引用 K4 的 docker compose run --rm land'));
        assert.ok(appended.includes('K4 未提供时说明并停下依赖步骤'));
        assert.doesNotMatch(appended, /npm run design:land/);
      }
    }
  }
});

test('工作室绑定允许回读 outputs 与 inputs 草稿，禁止覆盖产物及写入草稿', t => {
  const workspaceDir = tempRoot(t);
  for (const name of ['inputs/drafts', 'inputs/uploads', 'outputs']) fs.mkdirSync(path.join(workspaceDir, name), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'inputs/drafts/project.json'), '{"id":"task-helper","name":"事项整理助手"}');
  const sources = definition.agent.dataBindings.map(binding => ({ id: binding.sourceRef, locator: definition.bindings.sources[binding.sourceRef].root, actions: binding.actions, readOnly: definition.bindings.sources[binding.sourceRef].readOnly }));
  const tools = createFileTools(workspaceDir, { workspaceDir, sources, outputs: definition.agent.outputs });
  assert.equal(JSON.parse(tools.read_file({ path: 'inputs/drafts/project.json' }).content).id, 'task-helper');
  const result = tools.write_file({ path: 'outputs/design/task-helper/themes-r1.json', content: '{"shown":[]}' });
  assert.match(result.artifact.revision, /^[a-f0-9]{64}$/);
  assert.equal(tools.read_file({ path: result.path }).content, '{"shown":[]}');
  assert.throws(() => tools.write_file({ path: result.path, content: '{}' }), /覆盖/);
  assert.throws(() => tools.write_file({ path: 'inputs/drafts/project.json', content: '{}' }), /未授权/);
});

for (const schema of schemas) test(`工作室契约 ${path.basename(schema.$id)} 自身合法、严格编译且完整示例通过`, () => {
  assert.equal(ajv.validateSchema(schema), true);
  const name = path.basename(schema.$id).replace('.schema.json', '');
  valid(name, read(path.join(contract, 'examples', `${name}.json`)));
});

test('契约拒绝路径逃逸、多余字段、轮次越界、多题、多推荐和不安全 CSS', () => {
  for (const id of ['../x', '/tmp/x', 'A', 'a/b', 'x'.repeat(49)]) assert.equal(validator('project')({ id, name: '项目' }), false);
  const first = read(path.join(fixtures, 'clarify-r1.json'));
  for (const mutate of [v => { v.round = 4; }, v => { v.round = 3; }, v => { v.extra = true; }, v => { v.questions = Array(6).fill(v.questions[0]); }, v => { v.questions[0].options[1].recommended = true; }, v => { v.questions[0].options[0].recommended = false; }, v => { v.final = true; }]) {
    const value = structuredClone(first); mutate(value); assert.equal(validator('clarify')(value), false);
  }
  for (const file of ['clarify-r1.json', 'clarify-r2.json', 'clarify-r3.json', 'clarify-final-r1.json']) valid('clarify', read(path.join(fixtures, file)));
  const selected = read(path.join(fixtures, 'theme-v1.json'));
  for (const mutate of [v => { v.theme['--bg'] = 'url(https://example.com/a)'; }, v => { v.theme['--font-size-caption'] = '11px'; }, v => { v.style['--unknown'] = '1px'; }, v => { delete v.theme['--text']; }, v => { v.source.sample = '../escape.html'; }]) {
    const value = structuredClone(selected); mutate(value); assert.equal(validator('theme')(value), false);
  }
  const review = read(path.join(fixtures, 'qa/hifi-review-v2.json'));
  review.items[0].conclusion = 'unverified'; assert.equal(validator('review')(review), false);
  const manifest = read(path.join(fixtures, 'package-v1/manifest.json'));
  manifest.landing.command = '任意命令'; assert.equal(validator('manifest')(manifest), false);
});

function outline(file) {
  let reading = false, json = ''; const sections = [], links = [];
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'script' && attrs.id === 'design-outline') reading = true;
      if (name === 'section' && attrs['data-screen']) sections.push(`${attrs['data-screen']}/${attrs['data-state']}`);
      if (attrs.href?.startsWith('#screen=')) links.push(attrs.href);
    },
    ontext(text) { if (reading) json += text; },
    onclosetag(name) { if (name === 'script') reading = false; },
  });
  parser.end(fs.readFileSync(path.join(fixtures, file), 'utf8'));
  return { outline: JSON.parse(json), sections, links };
}

test('真实夹具四屏十状态、每个跳转存在，自审覆盖全部状态，原型修订不改大纲', () => {
  const first = outline('wireframe-v1.html');
  const screens = first.outline.groups.flatMap(group => group.screens);
  assert.equal(screens.length, 4);
  const expected = screens.flatMap(screen => screen.states.map(state => `${screen.id}/${state}`)).sort();
  assert.equal(expected.length, 10);
  for (const file of ['wireframe-v1.html', 'prototype-v1.html', 'prototype-v2.html']) {
    const actual = outline(file);
    assert.deepEqual(actual.outline, first.outline);
    assert.deepEqual(actual.sections.sort(), expected);
    for (const link of [...actual.links, ...screens.flatMap(screen => screen.actions.map(action => action.to))]) {
      const params = new URLSearchParams(link.slice(1));
      assert.ok(expected.includes(`${params.get('screen')}/${params.get('state')}`), link);
    }
  }
  for (const file of ['qa/lofi-review-v1.json', 'qa/hifi-review-v1.json', 'qa/hifi-review-v2.json']) {
    const value = read(path.join(fixtures, file)); valid('review', value);
    assert.deepEqual([...new Set(value.items.map(item => `${item.screen}/${item.state}`))].sort(), expected);
    assert.ok(value.items.every(item => item.evidence.includes('测试报告夹具')));
    for (const report of value.designReports) assert.ok(fs.existsSync(path.join(fixtures, report.reportPath)));
  }
});

test('主题候选历史完整、三套组合分别检查、确认来源可解析，所有 JSON 正式夹具合法', () => {
  const themes = read(path.join(fixtures, 'themes-r1.json')); valid('themes', themes);
  const ids = [...themes.styles, ...themes.themes].map(item => item.id);
  assert.deepEqual(themes.shown, ids);
  assert.deepEqual(themes.shownHistory.map(item => item.id), ids);
  assert.equal(new Set(themes.samples.map(s => s.artifact)).size, 3);
  for (const sample of themes.samples) {
    assert.ok(ids.includes(sample.styleId) && ids.includes(sample.themeId));
    assert.ok(fs.existsSync(path.join(fixtures, sample.artifact)));
    assert.ok(fs.existsSync(path.join(fixtures, sample.designReport.reportPath)));
  }
  for (const [name, file] of [['theme', 'theme-v1.json'], ['structure-changes', 'structure-changes-v1.json'], ['structure-changes', 'structure-changes-proposed-v2.json'], ['package-check', 'qa/package-check.json']]) valid(name, read(path.join(fixtures, file)));
  for (let n = 1; n <= 6; n++) valid('decisions', read(path.join(fixtures, `decisions-v${n}.json`)));
  const decisions = read(path.join(fixtures, 'decisions-v6.json'));
  const selected = read(path.join(fixtures, 'theme-v1.json'));
  assert.equal(selected.confirmedAt, decisions.events.find(event => event.artifact === 'theme-v1.json').confirmedAt);
  assert.equal(decisions.events.find(event => event.stage === 'hifi' && event.operation === 'modify').feedback, fs.readFileSync(path.join(fixtures, 'feedback.md'), 'utf8'));
});

test('示例代码包完整清单、真实 SHA-256、确认依赖和 K2 入口通过 check_agent_package', () => {
  const directory = path.join(fixtures, 'package-v1');
  const manifest = read(path.join(directory, 'manifest.json')); valid('manifest', manifest);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), files(directory).filter(file => file !== 'manifest.json'));
  for (const file of manifest.files) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(directory, file.path))).digest('hex'), file.sha256, file.path);
  for (const artifact of manifest.artifacts) for (const file of [artifact.path, ...artifact.inputs]) assert.ok(manifest.files.some(entry => entry.path === file), file);
  const result = checkAgentPackage(directory);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.issues, []);
  const prompt = fs.readFileSync(path.join(directory, 'PROMPT.md'), 'utf8');
  for (const term of ['落地命令', '前端按', '后端按', '检查与构建', '本机运行', 'flow-walkthrough', '等用户确认', '等用户反馈', '归类', '下一轮回归', 'production:check', '部署', '需要开发']) assert.ok(prompt.includes(term), term);
});

test('受信设计资源完整加载并可读 JSON/主题/声明，脚本和归档不携带且拒绝读取', async t => {
  const { AgentDefinition, skillFiles } = await import('../server/modules/agents/index.mjs');
  const { installSkills } = await import('../server/modules/codex/skills.mjs');
  const agent = new AgentDefinition(path.join(root, 'app'), path.join(studio, 'agent.json'));
  agent.availableSkills = agent.skills.map(skill => ({ ...skill, name: skill.id }));
  for (const [name, file] of [['studio-contract', 'schemas/clarify.schema.json'], ['studio-contract', 'resources/models.json'], ['theme-factory', 'themes/ocean-depths.md'], ['frontend-design', 'NOTICE.md']]) {
    assert.equal((await agent.readSkill(name, file)).content, fs.readFileSync(path.join(studio, 'skills', name, file), 'utf8'));
  }
  for (const file of ['scripts/init-artifact.sh', 'scripts/shadcn-components.tar.gz']) assert.throws(() => agent.readSkill('prototype-builder', file), /没有这个文件/);
  assert.throws(() => agent.readSkill('studio-contract', '../../role.md'), /没有这个文件/);
  const home = tempRoot(t);
  installSkills(agent, home);
  assert.equal(fs.existsSync(path.join(home, 'skills/prototype-builder/scripts')), false);
  const directory = path.join(home, 'resource-test'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '正文');
  fs.mkdirSync(path.join(directory, 'schemas')); fs.symlinkSync(path.join(studio, 'role.md'), path.join(directory, 'schemas/link.json'));
  assert.throws(() => skillFiles(directory), /符号链接/);
  fs.unlinkSync(path.join(directory, 'schemas/link.json'));
  fs.linkSync(path.join(directory, 'SKILL.md'), path.join(directory, 'schemas/link.json'));
  assert.throws(() => skillFiles(directory), /硬链接/);
  fs.unlinkSync(path.join(directory, 'schemas/link.json'));
  fs.writeFileSync(path.join(directory, 'schemas/big.json'), 'a'.repeat(128 * 1024 + 1));
  assert.throws(() => skillFiles(directory), /128 KiB/);
});


test('受信 Skill 文本白名单、文件数量与大小边界，脚本和二进制被拒绝', async t => {
  const { skillFiles } = await import('../server/modules/agents/index.mjs');
  const directory = path.join(tempRoot(t), 'text-resources'); fs.mkdirSync(directory);
  const allowed = ['SKILL.md', 'NOTICE.md', 'LICENSE.txt', 'LICENSE-spec-kit.txt', 'references/nested/guide.md', 'references/note.txt', 'themes/nested/style.md', 'schemas/nested/a.json', 'examples/a.json', 'resources/a.json'];
  const write = (file, content = '文本') => { const target = path.join(directory, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  for (const file of allowed) write(file);
  assert.deepEqual(skillFiles(directory).sort(), allowed.sort());
  for (const file of ['scripts/run.sh', 'scripts/data.json', 'archive.tar.gz', 'schemas/run.sh', 'themes/a.txt', 'resources/a.md', 'references/a.json', 'references-evil/a.md', 'image.png']) {
    write(file);
    assert.throws(() => skillFiles(directory), /Skill 只能包含/, file);
    fs.unlinkSync(path.join(directory, file));
    const parent = path.dirname(file);
    if (['scripts', 'references-evil'].includes(parent)) fs.rmdirSync(path.join(directory, parent));
  }
  write('resources/limit.json', 'a'.repeat(128 * 1024));
  assert.ok(skillFiles(directory).includes('resources/limit.json'));
  write('resources/limit.json', 'a'.repeat(128 * 1024 + 1));
  assert.throws(() => skillFiles(directory), /128 KiB/);
  fs.unlinkSync(path.join(directory, 'resources/limit.json'));
  for (let n = allowed.length; n < 50; n++) write(`examples/file-${n}.json`);
  assert.equal(skillFiles(directory).length, 50);
  write('examples/extra.json');
  assert.throws(() => skillFiles(directory), /文件过多/);
});

test('草稿以契约为准，hifi 未检查组合先检查后写 theme-v，聊天意见只走 feedback', () => {
  const contractText = fs.readFileSync(path.join(contract, 'SKILL.md'), 'utf8');
  const byId = Object.fromEntries(definition.agent.workflows[0].steps.map(step => [step.id, step.goal]));
  for (const text of [role, contractText, ...Object.values(byId)]) {
    assert.doesNotMatch(text, /inputs\/drafts\/(?:prd|lofi|hifi|package)\.md|prd\.md、lofi\.md、hifi\.md、package\.md/);
  }
  for (const trigger of ['提交第 n 轮澄清答案', '换一换：风格', '换一换：主题', '按结构改动决定生成', '确认，生成高保真']) assert.ok(contractText.includes(trigger), trigger);
  assert.match(role, /feedback/); assert.match(role, /原话.*decisions/);
  assert.doesNotMatch(byId.lofi, /auto=1/);
  assert.doesNotMatch(byId.theme, /needs\.image|theme-v<n>\.json/);
  assert.doesNotMatch(byId.package, /design:land/);
  for (const text of [byId.hifi, contractText]) {
    const start = text.indexOf('hifi 开头');
    const selection = text.indexOf('theme.json', Math.max(start, 0));
    const sample = text.indexOf('新建默认令牌为该组合的 theme-sample-v<n>.html', selection);
    const check = text.indexOf('check_design', sample);
    const passed = text.indexOf('status=completed 且 errors=0', check);
    const theme = text.indexOf('只写一份 theme-v<n>.json', passed);
    assert.ok(selection >= 0 && selection < sample && sample < check && check < passed && passed < theme, '核对选择、建立所选组合样页、检查通过后才写一份主题文件');
    assert.match(text.slice(selection, theme), /已有通过的样页检查报告就直接引用/);
    assert.match(text.slice(passed, theme), /最多修 2 轮/);
    assert.match(text.slice(passed, theme), /工具不可用.*停在确认点/);
    assert.doesNotMatch(text, /预留新样页路径|写入新版本 theme 文件|designReport=null|首份 theme/);
  }
  assert.ok(byId.hifi.indexOf('只写一份 theme-v<n>.json') < byId.hifi.indexOf('写 prototype-v<n>.html'));
  for (const term of ['shownHistory', '不能自己选', 'check_design', '缺失或无效']) assert.ok(byId.hifi.includes(term), term);
  const drafts = new Set(['project.json', 'brief.json', 'clarify.json', 'theme.json', 'structure-changes.json']);
  for (const text of [role, ...Object.values(byId)]) for (const [, name] of text.matchAll(/inputs\/drafts\/([a-z.-]+\.(?:json|md))/g)) assert.ok(drafts.has(name), name);
});


test('主题选择必须带完整报告，拒绝 null、缺失字段及无效报告', () => {
  const selected = read(path.join(fixtures, 'theme-v1.json'));
  valid('theme', selected);
  for (const report of [null, { status: 'completed', errors: 0 },
    { ...selected.designReport, status: 'unverified' }, { ...selected.designReport, extra: true },
    { ...selected.designReport, errors: '0' }]) {
    assert.equal(validator('theme')({ ...selected, designReport: report }), false);
  }
  for (const field of Object.keys(selected.designReport)) {
    const value = structuredClone(selected); delete value.designReport[field];
    assert.equal(validator('theme')(value), false, field);
  }
  delete selected.designReport;
  assert.equal(validator('theme')(selected), false);
});
