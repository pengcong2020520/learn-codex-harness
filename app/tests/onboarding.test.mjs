import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { newAgent } from '../scripts/agent-new.mjs';
import { checkAgent } from '../scripts/agent-check.mjs';
import { useAgent } from '../scripts/agent-use.mjs';
import { checkProduction, formatProductionChecks } from '../scripts/production-check.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-onboarding-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['agents', 'config', 'examples']) fs.cpSync(new URL(`../${dir}`, import.meta.url), path.join(root, dir), { recursive: true });
  newAgent('sample', { root, log() {} });
  const file = path.join(root, 'agents/sample/agent.json');
  const edit = change => { const value = JSON.parse(fs.readFileSync(file)); change(value); fs.writeFileSync(file, JSON.stringify(value)); };
  return { root, file, edit };
}
const errors = rows => rows.filter(row => row.level === 'error');
const sample = 'agents/sample/agent.json';

test('agent:check 示例和骨架通过，占位角色与缺资料仅建议', t => {
  const { root } = fixture(t);
  for (const file of ['agents/writing/agent.json', 'examples/writing/agent/agent.json', 'examples/customer-support/agent/agent.json', sample]) {
    assert.deepEqual(errors(checkAgent(file, { root })), []);
  }
  const rows = checkAgent(sample, { root });
  assert.ok(rows.some(row => row.level === 'warning' && /角色仍是占位文字/.test(row.detail)));
  assert.ok(rows.some(row => row.level === 'warning' && /dataBindings/.test(row.title)));
});

for (const [name, change, field, fix] of [
  ['缺 Skill 文件', f => fs.unlinkSync(path.join(f.root, 'agents/sample/skills/task-guide/SKILL.md')), /bindings.skills/, /SKILL.md/],
  ['缺 frontmatter', f => fs.writeFileSync(path.join(f.root, 'agents/sample/skills/task-guide/SKILL.md'), '# 方法\n'), /frontmatter/, /name.*description/],
  ['缺角色', f => fs.unlinkSync(path.join(f.root, 'agents/sample/role.md')), /instructions/, /角色/],
  ['空角色', f => fs.writeFileSync(path.join(f.root, 'agents/sample/role.md'), ' \n'), /instructions/, /角色/],
  ['未知模型', f => f.edit(v => { v.agent.workflows[0].steps[0].model = 'unknown/missing'; }), /workflows\[0\].steps\[0\].model/, /config\/models.json.*chat/],
  ['非对话模型', f => f.edit(v => { v.agent.workflows[0].steps[0].model = 'ollama/qwen3-embedding:0.6b'; }), /steps\[0\].model/, /chat/],
  ['未知 Skill 引用', f => f.edit(v => { v.agent.workflows[0].skill = 'absent'; }), /workflows\[0\].skill/, /agent.skills/],
  ['非法格式', f => f.edit(v => { v.agent.outputs.formats = ['pdf']; }), /outputs\/formats/, /md.*txt/],
  ['图片能力不足', f => f.edit(v => { Object.assign(v.agent.workflows[0].steps[0], { model: 'zhipu/glm-5.3', needs: { image: true } }); }), /steps\[0\].model/, /image/],
]) test(`agent:check 定位与改法：${name}`, t => {
  const f = fixture(t); change(f);
  const rows = errors(checkAgent(sample, { root: f.root }));
  assert.ok(rows.some(row => field.test(row.title) && fix.test(row.fix)), JSON.stringify(rows));
});

test('agent:check 场景模型复用路由，存在的资料目录不再建议', t => {
  const f = fixture(t);
  f.edit(v => { v.agent.workflows[0].steps[0].model = 'fast'; });
  fs.mkdirSync(path.join(f.root, 'workspace/inputs'), { recursive: true });
  const rows = checkAgent(sample, { root: f.root });
  assert.deepEqual(errors(rows), []);
  assert.equal(rows.some(row => /dataBindings/.test(row.title)), false);
});

for (const ending of ['\n', '\r\n']) for (const existing of [true, false]) {
  test(`agent:use ${existing ? '替换' : '追加'}，保留其他字节、权限和属主 ${JSON.stringify(ending)}`, t => {
    const { root } = fixture(t), file = path.join(root, '.env'), logs = [];
    const before = ['# 保留注释', "EXTRA='fixture-private-value'", 'MULTILINE="first', 'AGENT_DEFINITION=inside-value', 'last"', ...(existing ? ['export AGENT_DEFINITION = old-selection'] : []), 'TAIL=fixture-tail'].join(ending);
    fs.writeFileSync(file, before, { mode: 0o600 });
    const stat = fs.statSync(file);
    useAgent('sample', { root, log: line => logs.push(line) });
    const after = fs.readFileSync(file, 'utf8'), next = fs.statSync(file);
    const replacement = `AGENT_DEFINITION='${sample}'`;
    assert.equal(after, existing ? before.replace('export AGENT_DEFINITION = old-selection', replacement) : before + ending + replacement + ending);
    assert.equal(next.mode & 0o777, 0o600);
    assert.equal(next.uid, stat.uid); assert.equal(next.gid, stat.gid);
    assert.notEqual(next.ino, stat.ino);
    for (const value of Object.values(parseEnv(before))) assert.equal(logs.join('\n').includes(value), false);
    assert.match(logs.join('\n'), /npm run up/);
  });
}

test('agent:use 校验失败不写文件，不回显配置；路径也能切换', t => {
  const f = fixture(t), file = path.join(f.root, '.env');
  fs.writeFileSync(file, 'PRIVATE=fixture-sensitive\n', { mode: 0o600 });
  const before = fs.readFileSync(file), inode = fs.statSync(file).ino;
  f.edit(v => { v.agent.outputs.formats = ['pdf']; });
  assert.throws(() => useAgent(sample, { root: f.root }), /agent:check/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).ino, inode);
  f.edit(v => { v.agent.outputs.formats = ['md']; });
  useAgent(f.file, { root: f.root, log() {} });
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).AGENT_DEFINITION, sample);
});

test('agent:use 拒绝符号链接和重复定义，不破坏原文件', t => {
  const { root } = fixture(t), file = path.join(root, '.env'), target = path.join(root, 'env-target');
  fs.writeFileSync(target, 'PRIVATE=fixture-sensitive\n', { mode: 0o600 }); fs.symlinkSync(target, file);
  assert.throws(() => useAgent('sample', { root }), /普通文件/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'PRIVATE=fixture-sensitive\n');
  fs.unlinkSync(file);
  const text = 'AGENT_DEFINITION=first\nAGENT_DEFINITION=second\n'; fs.writeFileSync(file, text, { mode: 0o600 });
  assert.throws(() => useAgent('sample', { root }), /重复/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('agent:use 多行目标定义停止核对，空配置可追加并收紧权限', t => {
  const { root } = fixture(t), file = path.join(root, '.env');
  const before = 'AGENT_DEFINITION="first\nsecond"\nPRIVATE=fixture-sensitive\n';
  fs.writeFileSync(file, before, { mode: 0o600 });
  assert.throws(() => useAgent('sample', { root }), /单行/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, ''); fs.chmodSync(file, 0o644);
  useAgent('sample', { root, log() {} });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), `AGENT_DEFINITION='${sample}'\n`);
});

test('agent:check 角色与 Skill 的符号链接被拒绝，修改后的角色不再提示占位', t => {
  const { root } = fixture(t), role = path.join(root, 'agents/sample/role.md');
  fs.writeFileSync(role, '# 客服助手\n只回答资料里有依据的问题。\n');
  assert.equal(checkAgent(sample, { root }).some(row => /占位/.test(row.detail)), false);
  fs.renameSync(role, `${role}.original`); fs.symlinkSync('role.md.original', role);
  assert.ok(errors(checkAgent(sample, { root })).some(row => /instructions/.test(row.title)));
});

function productionFixture(t) {
  const f = fixture(t), now = Date.parse('2026-11-14T12:00:00Z');
  const env = { AGENT_DOMAIN: 'service.example.com', COMPOSE_PROFILES: 'cluster,https', AGENT_ALLOWED_ORIGINS: 'https://service.example.com', CONTAINER_APP_DIR: f.root,
    CODEX_MODEL: 'deepseek/deepseek-flash', DEEPSEEK_API_KEY: 'fixture-default-provider', KIMI_API_KEY: 'fixture-backup-provider',
    AGENT_BUDGET_DAILY_TOKENS: '987654', AGENT_CLUSTER_NODES: 'node-a,node-b', AGENT_DEFINITION: sample };
  const write = () => fs.writeFileSync(path.join(f.root, '.env'), Object.entries(env).map(([key, value]) => `${key}='${value}'\n`).join(''), { mode: 0o600 });
  const backup = path.join(f.root, 'backups/node-a/2026-11-14T12-00-00-000Z');
  fs.mkdirSync(backup, { recursive: true });
  const files = {};
  for (const name of ['database.sql.gz', 'workspace.tar.gz', 'codex.tar.gz', 'state.tar.gz']) {
    fs.writeFileSync(path.join(backup, name), 'fixture'); files[name] = { size: 7, sha256: 'a'.repeat(64) };
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ time: new Date(now).toISOString(), files }));
  write(); return { ...f, now, env, write, backup };
}

test('production:check 全部静态项通过，未检查项明确且所有配置值不回显', t => {
  const f = productionFixture(t), rows = checkProduction(f);
  assert.deepEqual(rows.map(row => row.id), ['origins', 'env-file', 'deployment-directory', 'default-model', 'fallback-model', 'budget', 'backup', 'topology', 'agent']);
  assert.ok(rows.every(row => row.level === 'ok'));
  const output = formatProductionChecks(rows);
  assert.match(output, /未检查.*登录.*对话/);
  for (const value of Object.values(f.env)) assert.equal(output.includes(value), false, '不得回显配置值');
  for (const row of rows) assert.deepEqual(Object.keys(row), ['id', 'level', 'title', 'detail', 'fix']);
});

for (const [name, change, id, level] of [
  ['本机 origin', f => { f.env.AGENT_ALLOWED_ORIGINS = 'http://127.0.0.1:4317'; }, 'origins', 'error'],
  ['HTTPS 本机', f => { f.env.AGENT_ALLOWED_ORIGINS = 'https://localhost'; }, 'origins', 'error'],
  ['HTTPS 本机绝对域名', f => { f.env.AGENT_ALLOWED_ORIGINS = 'https://localhost.'; }, 'origins', 'error'],
  ['origin 带路径', f => { f.env.AGENT_ALLOWED_ORIGINS = 'https://service.example.com/path'; }, 'origins', 'error'],
  ['只有来源没有 edge', f => { delete f.env.COMPOSE_PROFILES; }, 'origins', 'warning'],
  ['缺少域名', f => { delete f.env.AGENT_DOMAIN; }, 'origins', 'warning'],
  ['域名与来源不匹配', f => { f.env.AGENT_DOMAIN = 'other.example.com'; }, 'origins', 'warning'],
  ['目录搬家', f => { f.env.CONTAINER_APP_DIR = '/opt/old-deployment'; }, 'deployment-directory', 'error'],
  ['默认 Key 空', f => { f.env.DEEPSEEK_API_KEY = ''; }, 'default-model', 'error'],
  ['默认模型未知', f => { f.env.CODEX_MODEL = 'missing/model'; }, 'default-model', 'error'],
  ['备用 Key 空', f => { f.env.KIMI_API_KEY = ''; }, 'fallback-model', 'warning'],
  ['预算未设', f => { delete f.env.AGENT_BUDGET_DAILY_TOKENS; }, 'budget', 'warning'],
  ['时区不是预算上限', f => { delete f.env.AGENT_BUDGET_DAILY_TOKENS; f.env.AGENT_BUDGET_TIMEZONE = 'UTC'; }, 'budget', 'warning'],
  ['预算无效', f => { f.env.AGENT_BUDGET_DAILY_TOKENS = 'invalid'; }, 'budget', 'error'],
  ['没有备份', f => fs.rmSync(f.backup, { recursive: true }), 'backup', 'warning'],
  ['备份超过七天', f => { f.now += 7 * 86400000 + 1; }, 'backup', 'warning'],
  ['不完整备份', f => fs.unlinkSync(path.join(f.backup, 'codex.tar.gz')), 'backup', 'warning'],
  ['未来备份', f => { f.now -= 1; }, 'backup', 'warning'],
  ['单节点', f => { f.env.AGENT_CLUSTER_NODES = 'node-a'; }, 'topology', 'warning'],
  ['无效拓扑', f => { f.env.AGENT_CLUSTER_NODES = 'invalid'; }, 'topology', 'error'],
  ['Agent 无效', f => f.edit(v => { v.agent.outputs.formats = ['pdf']; }), 'agent', 'error'],
]) test(`production:check ${name}`, t => {
  const f = productionFixture(t); change(f); f.write();
  const rows = checkProduction(f);
  assert.equal(rows.find(row => row.id === id).level, level);
  const output = formatProductionChecks(rows);
  for (const value of Object.values(f.env).filter(Boolean)) assert.equal(output.includes(value), false, '不得回显配置值');
});

test('production:check 权限、缺文件与符号链接均报错，不跟随链接', t => {
  const f = productionFixture(t), file = path.join(f.root, '.env');
  fs.chmodSync(file, 0o644);
  assert.equal(checkProduction(f).find(row => row.id === 'env-file').level, 'error');
  fs.unlinkSync(file);
  assert.equal(checkProduction(f).find(row => row.id === 'env-file').level, 'error');
  fs.symlinkSync('missing-target', file);
  assert.equal(checkProduction(f).find(row => row.id === 'env-file').level, 'error');
});

test('production:check 七天边界、零预算及最新完整备份', t => {
  const f = productionFixture(t);
  f.now += 7 * 86400000;
  f.env.AGENT_BUDGET_DAILY_TOKENS = '0'; f.write();
  const rows = checkProduction(f);
  assert.equal(rows.find(row => row.id === 'backup').level, 'ok');
  assert.equal(rows.find(row => row.id === 'budget').level, 'ok');
  fs.symlinkSync(f.backup, path.join(f.root, 'backups/node-a/2026-11-15T12-00-00-000Z'));
  assert.equal(checkProduction(f).find(row => row.id === 'backup').detail, rows.find(row => row.id === 'backup').detail);
});

test('production:check 宿主与 --root 加 HOST_APP_DIR 逐项输出和退出码一致', t => {
  const f = productionFixture(t);
  const manifestFile = path.join(f.backup, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.time = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const mounted = fs.mkdtempSync(path.join(os.tmpdir(), 'production-project-'));
  t.after(() => fs.rmSync(mounted, { recursive: true, force: true }));
  const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'production-image-'));
  t.after(() => fs.rmSync(imageRoot, { recursive: true, force: true }));
  for (const root of [f.root, imageRoot]) {
    for (const dir of ['scripts', 'server', 'shared']) fs.cpSync(new URL(`../${dir}`, import.meta.url), path.join(root, dir), { recursive: true });
    fs.symlinkSync(fs.realpathSync(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'));
  }
  const env = { ...process.env }; delete env.HOST_APP_DIR;
  // 保留强制颜色覆盖，避免继承的 NO_COLOR 让 Node 向 stderr 写入冲突警告。
  if (env.FORCE_COLOR !== undefined) delete env.NO_COLOR;
  const run = (args, extra = {}) => spawnSync(process.execPath, ['scripts/production-check.mjs', ...args], { cwd: args.length ? imageRoot : f.root, env: { ...env, ...extra }, encoding: 'utf8' });
  for (const [name, change, id, level] of [
    ['配置完整', () => {}, 'deployment-directory', 'ok'],
    ['目录搬家', () => { f.env.CONTAINER_APP_DIR = '/opt/old-deployment'; f.write(); }, 'deployment-directory', 'error'],
    ['Agent 无效', () => f.edit(v => { v.agent.outputs.formats = ['pdf']; }), 'agent', 'error'],
    ['模型目录缺失', () => fs.unlinkSync(path.join(f.root, 'config/models.json')), 'default-model', 'error'],
    ['备份缺失', () => fs.rmSync(f.backup, { recursive: true }), 'backup', 'warning'],
    ['环境文件缺失', () => fs.unlinkSync(path.join(f.root, '.env')), 'env-file', 'error'],
  ]) {
    change();
    // 只复制待检查的文件，挂载目录不提供脚本或依赖；两种入口检查同一份配置。
    for (const entry of ['.env', 'agents', 'config', 'backups']) {
      const source = path.join(f.root, entry), target = path.join(mounted, entry);
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true });
    }
    const rows = checkProduction({ root: f.root });
    assert.equal(rows.find(row => row.id === id).level, level, name);
    if (name === '配置完整') assert.ok(rows.every(row => row.level === 'ok'));
    const host = run([]), container = run(['--root', mounted], { HOST_APP_DIR: f.root });
    assert.equal(host.status, errors(rows).length ? 1 : 0, name);
    assert.equal(host.stdout.trimEnd(), formatProductionChecks(rows), name);
    assert.equal(container.status, host.status, name);
    assert.deepEqual(container.stdout.split('\n'), host.stdout.split('\n'), name);
    assert.equal(host.stderr, '', name); assert.equal(container.stderr, '', name);
    if (name === '配置完整') {
      const moved = run(['--root', mounted], { HOST_APP_DIR: '/opt/moved-deployment' });
      assert.equal(moved.status, 1);
      assert.match(moved.stdout, /✗ CONTAINER_APP_DIR/);
    }
  }
});

test('production:check CLI 拒绝缺少目录、未知参数和多余参数', () => {
  for (const args of [['--root'], ['--root', ''], ['--root', '--unknown'], ['--unknown'], ['--root', '', 'extra']]) {
    const result = spawnSync(process.execPath, ['scripts/production-check.mjs', ...args], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /用法.*--root/);
  }
});

test('三个命令 CLI 退出码与输出脱敏', t => {
  const f = productionFixture(t);
  // CLI 固定从脚本所在应用目录取配置；复制代码只操作临时配置，不碰真实 .env。
  for (const dir of ['scripts', 'server', 'shared']) fs.cpSync(new URL(`../${dir}`, import.meta.url), path.join(f.root, dir), { recursive: true });
  fs.symlinkSync(fs.realpathSync(new URL('../node_modules', import.meta.url)), path.join(f.root, 'node_modules'));
  const run = (script, args = []) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: f.root, encoding: 'utf8' });
  for (const [script, args, code] of [['agent-check', [sample], 0], ['agent-use', ['sample'], 0], ['production-check', [], 0]]) {
    const result = run(script, args); assert.equal(result.status, code, `${script}: ${result.stderr}${result.stdout}`);
    for (const value of Object.values(f.env)) if (script !== 'agent-check') assert.equal((result.stdout + result.stderr).includes(value), false);
  }
  f.edit(v => { v.agent.outputs.formats = ['pdf']; });
  for (const [script, args] of [['agent-check', [sample]], ['agent-use', ['sample']], ['production-check', []]]) assert.equal(run(script, args).status, 1);
});
