import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { discover, land, verifyLanding } from '../scripts/design-land.mjs';
import { selectAgentFile } from '../server/modules/agents/selection.mjs';

const app = new URL('../', import.meta.url);
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'land-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['config', 'agents/studio', '.env.example']) fs.cpSync(new URL(file, app), path.join(root, file), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'COMPOSE_PROFILES=cluster,studio\nAGENT_DEFINITION=agents/studio/agent.json\nOTHER=keep\n', { mode: 0o600 });
  const source = path.join(root, 'nodes/node-a/workspace/users/test/outputs/design/task-helper/package-v1');
  fs.cpSync(new URL('tests/fixtures/studio/package-v1/', app), source, { recursive: true });
  return { root, source };
}

test('新安装使用工作室，已有写作助手选择可加载原地自定义或迁移后的示例', () => {
  const root = fs.realpathSync(app);
  assert.equal(selectAgentFile(root), path.join(root, 'agents/studio/agent.json'));
  assert.equal(selectAgentFile(root, 'agents/writing/agent.json'), path.join(root, 'examples/writing-assistant/agent.json'));
  assert.equal(parseEnv(fs.readFileSync(new URL('.env.example', app), 'utf8')).COMPOSE_PROFILES, 'studio');
});
test('落地选择唯一项目最新包，检查真实文件并切换，手动重入保留开发改动', async t => {
  const { root, source } = fixture(t);
  fs.mkdirSync(path.join(path.dirname(source), 'package-v10'));
  assert.match(discover(root), /package-v10$/);
  fs.rmdirSync(path.join(path.dirname(source), 'package-v10'));
  const result = await land(root);
  assert.equal(result.selected, 'agents/task-helper/agent.json');
  assert.equal(selectAgentFile(root), path.join(root, result.selected));
  assert.equal(fs.existsSync(path.join(root, 'agents/studio')), false);
  assert.ok(fs.existsSync(path.join(root, 'design/task-helper/prototype-v2.html')));
  assert.deepEqual({ ...parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')) }, { COMPOSE_PROFILES: 'cluster', AGENT_DEFINITION: result.selected, OTHER: 'keep' });
  const role = path.join(root, 'agents/task-helper/role.md');
  fs.appendFileSync(role, '开发补充');
  assert.deepEqual(await land(root), result);
  assert.match(fs.readFileSync(role, 'utf8'), /开发补充$/);
});
test('落地拒绝被改动的包、重名目录和跨项目猜选', async t => {
  const { root, source } = fixture(t);
  fs.mkdirSync(path.join(root, 'agents/task-helper'));
  await assert.rejects(land(root), /已存在/);
  fs.rmdirSync(path.join(root, 'agents/task-helper'));
  fs.appendFileSync(path.join(source, 'agent/role.md'), '改动');
  await assert.rejects(land(root), /manifest-hash/);
  fs.mkdirSync(path.resolve(source, '../../second/package-v1'), { recursive: true });
  assert.throws(() => discover(root), /多个设计项目/);
  assert.ok(fs.existsSync(path.join(root, 'agents/studio')));
});
test('配置冲突中断后按同一清单继续，保留已安装目录', async t => {
  const { root } = fixture(t), file = path.join(root, '.env');
  fs.appendFileSync(file, 'AGENT_DEFINITION=other\n');
  await assert.rejects(land(root), /重复/);
  const agent = path.join(root, 'agents/task-helper/agent.json'), ino = fs.statSync(agent).ino;
  fs.writeFileSync(file, 'AGENT_DEFINITION=agents/studio/agent.json\n');
  assert.ok((await land(root)).done);
  assert.equal(fs.statSync(agent).ino, ino);
});

test('落地完成须核对就绪、Caddy 跳转以及真实产品入口内容', async t => {
  const { root } = fixture(t), result = await land(root), env = { AGENT_DEFINITION: result.selected };
  const bytes = fs.readFileSync(path.join(root, 'agents/task-helper/ui/index.html'));
  const serve = body => async url => url.endsWith('/ready') ? new Response('{}') : url.endsWith('/app/') ? new Response(body) : new Response(null, { status: 302, headers: { location: '/app/' } });
  await verifyLanding(root, env, serve(bytes));
  await assert.rejects(verifyLanding(root, env, serve('旧页面')), /入口不一致/);
});
