// Real HTTP + PostgreSQL/Redis + native per-uid Codex. Only model responses are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startAgentServer } from '../server/main.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { openDatabase, migrate, identity } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts, addUser } from '../server/modules/accounts/admin.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { userSpawn } from '../server/modules/codex/launch.mjs';
import { readAsUser } from '../server/modules/runtimes/user-files.mjs';
import { installToolFixture, tempRoot, cleanup, until } from './helpers.mjs';
import { responsesFixture, answer, toolCall, toolSpecs } from './responses-fixture.mjs';

const linuxUid = process.platform === 'linux' && process.getuid?.() === 0;
test('Linux isolated HTTP：bob(pro) 新建知识库→导入→knowledge-maintain→completed/wiki-effective', {
  skip: !linuxUid && '需要可切换 uid/gid 的 Linux 0:1000 环境', timeout: 120000,
}, async t => {
  assert.equal(process.getgid(), 1000, '使用 --user 0:1000');
  const probe = userSpawn(process.execPath, ['-e', ''], { isolated: true, uid: 10002, gid: 10002 });
  const checked = spawnSync(probe.command, probe.args, { ...probe.options, cwd: '/tmp', encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
  assert.ok(databaseUrl && redisUrl, '设置专用 DATA_TEST_DATABASE_URL 与 DATA_TEST_REDIS_URL；不可使用生产库。');
  const root = installToolFixture(tempRoot(t), { knowledge: true }); fs.chmodSync(root, 0o755);
  const db = await openDatabase(databaseUrl); cleanup(root, () => db.end()); await migrate(db);
  const scope = identity(root), accounts = new AccountStore(db, scope.instanceId);
  await initializeAccounts(accounts, { ownerId: scope.ownerId, username: 'alice', password: 'fixture-password', workspace: path.join(root, 'workspace') });
  const bob = await addUser(accounts, { username: 'bob', password: 'fixture-password' });
  await accounts.query("UPDATE agent_data.users SET plan_id='pro' WHERE instance_id=$1 AND id=$2", [bob.id]);
  // No DAC_OVERRIDE: remove private native files as their owner after app.close(), before tempRoot cleanup.
  cleanup(root, async () => {
    const { rows } = await db.query('SELECT user_id,uid,codex_home FROM agent_data.user_runtimes WHERE instance_id=$1', [scope.instanceId]);
    for (const row of rows) {
      const dirs = [row.codex_home, path.join(root, '.runs/users', row.user_id), path.join(root, 'workspace/users', row.user_id)].filter(dir => fs.existsSync(dir));
      const launch = userSpawn(process.execPath, ['-e', "const fs=require('node:fs'),p=require('node:path');for(const dir of process.argv.slice(1))for(const name of fs.readdirSync(dir))fs.rmSync(p.join(dir,name),{recursive:true,force:true});", ...dirs], { isolated: true, uid: row.uid, gid: row.uid });
      const child = spawnSync(launch.command, launch.args, { ...launch.options, cwd: '/tmp', encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr || child.error?.message);
    }
  });
  const kbId = 'bob-notes', slug = 'services', content = '# Bob notes\n门店提供配送、提货、咨询服务。';
  let step = 0, refs;
  const provider = await responsesFixture(root, body => {
    const call = (name, args) => {
      const spec = toolSpecs(body).find(tool => tool.name === name); assert.ok(spec, `missing tool ${name}`);
      return toolCall(spec, args);
    };
    const outputs = (body.input || []).filter(item => item.type === 'function_call_output').map(item =>
      JSON.parse(typeof item.output === 'string' ? item.output : item.output[0].text));
    if (step++ === 0) return call('read_file', { path: `inputs/${kbId}/source.md` });
    if (step === 2) {
      const source = outputs.at(-1); assert.ok(source.resourceId && source.versionId);
      refs = [{ resourceId: source.resourceId, versionId: source.versionId }];
      return call('kb_submit_revision', { kbId, slug, content, expectedVersion: null, source_versions: refs });
    }
    assert.equal(outputs.at(-1).effective, true);
    return answer('Wiki 已生成。');
  });
  const config = loadServerConfig(root, { CODEX_API_KEY: 'local-test-only', CODEX_BASE_URL: provider.url,
    CODEX_MODEL: 'local-test-model', CODEX_MODEL_CATALOG_ENABLED: 'true', CODEX_MODEL_CONTEXT_WINDOW: '128000',
    DEMO_TIMEOUT_MS: '30000', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl }); config.port = 0;
  const logs = [], app = await startAgentServer({ config, log: line => logs.push(line) }); cleanup(root, () => app.close());
  assert.equal(app.rpc.isolated, true, '绝不能通过共享 Agent/运行环境回退掩盖问题');
  const loginResponse = await fetch(app.url + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'fixture-password' }) });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json(); assert.equal(login.user.role, 'user');
  const api = async (route, body, expected = 200) => {
    const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const created = await api('/knowledge', { kbId, title: 'Bob notes' }, 201);
  assert.equal(created.ownerId, bob.id); assert.equal(created.visibility, 'private');
  const entry = app.runtimes.pool.entries.get(bob.id), value = entry.value, pid = value.rpc.child.pid;
  assert.equal(value.runtime.isolated, true);
  const proc = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  assert.equal(Number(proc.match(/^Uid:\s+(\d+)/m)[1]), value.runtime.uid);
  assert.equal(Number(proc.match(/^Gid:\s+(\d+)/m)[1]), value.runtime.uid);
  assert.ok(value.runtime.uid >= 10001); // allocated per-user uid (first allocation may be bob)
  const imported = await api('/knowledge/source', { kbId, name: 'source.md', content }, 201);
  const session = await api('/sessions', {}, 201);
  await api('/messages', { threadId: session.id, clientMessageId: 'uid-maintain', text: '维护知识库',
    workflow: 'knowledge-maintain', params: { kbId } }, 202);
  const getJob = () => runOwner(bob.id, () => app.data.jobs.get('uid-maintain'));
  await until(async () => ['completed', 'needs-review', 'failed', 'unconfirmed', 'interrupted'].includes((await getJob())?.status), 60000);
  const job = await getJob();
  assert.equal(job.status, 'completed', JSON.stringify({ job, logs }));
  assert.deepEqual(job.checks.map(check => [check.id, check.passed]), [['wiki-effective', true]]);
  assert.equal(job.error, null); assert.equal(refs[0].resourceId, imported.resourceId);
  const page = await api(`/knowledge/read?kbId=${kbId}&slug=${slug}`);
  assert.equal(page.content, content);
  const stored = (await db.query('SELECT current_version FROM agent_data.wiki_pages WHERE instance_id=$1 AND kb_id=$2 AND slug=$3', [scope.instanceId, kbId, slug])).rows[0];
  assert.equal(stored.current_version, page.versionId, 'Wiki 以生效版本与 blob 持久化，不假设生成工作区 .md 文件');
  const source = path.join(value.runtime.workspaceDir, `inputs/${kbId}/source.md`);
  assert.equal((await readAsUser(value.runtime.uid, source, { isolated: true, maxBytes: 128 * 1024 })).toString(), content);
  assert.strictEqual(app.runtimes.pool.entries.get(bob.id), entry, '新建库与维护无需重启用户运行环境');
  assert.equal(value.rpc.child.pid, pid); assert.equal(value.rpc.child.exitCode, null);
  assert.equal(await runOwner(bob.id, () => app.data.jobs.paused(session.id)), false);
  assert.deepEqual(provider.errors, []);
  t.diagnostic(`isolated=true; bob uid=${value.runtime.uid}; pid=${pid}; completed + wiki-effective; 未重启。`);
});
