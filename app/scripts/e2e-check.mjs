// 端到端检查（由 scripts/e2e-compose.sh 调用）：经入口 Caddy 访问已启动的单节点脚手架。
// 不调用模型：只检查就绪、登录、拓扑、会话创建（会拉起该用户自己的 Codex 进程）和拒绝未认证请求。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const url = `http://127.0.0.1:${process.env.AGENT_PORT || 4317}`;
import { createPrompts } from '../shared/prompts.mjs';
const prompts = createPrompts();
let password;
try { password = await prompts.ask('管理员密码：', { secret: true }); } finally { prompts.close(); }
if (!password) throw new Error('请经 stdin 提供管理员密码。');

async function until(check, label, ms = 120_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if (await check()) return; } catch { /* 服务还在启动 */ }
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// 失败时打出状态码和返回内容（错误信息不含密钥），方便在 CI 日志里定位。
async function expectStatus(response, status, label) {
  if (response.status === status) return response;
  throw new Error(`${label}：期望 HTTP ${status}，实际 ${response.status}：${(await response.text()).slice(0, 500)}`);
}

await until(async () => (await fetch(`${url}/ready`)).status === 200, '/ready 返回 200');
const ready = await (await fetch(`${url}/ready`)).json();
assert.equal(ready.replication, 'off', '单节点 /ready 应显示复制关闭');
assert.equal(ready.degraded, undefined, '单节点不应因没有副本而降级');

const login = await fetch(`${url}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }),
});
await expectStatus(login, 200, '管理员登录');
const { token } = await login.json();
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const cluster = await (await fetch(`${url}/cluster`, { headers })).json();
assert.equal(cluster.replication, 'off');
assert.equal(cluster.shards.length, 3);
for (const shard of cluster.shards) {
  assert.equal(shard.primary, 'node-a', `分片 ${shard.shardId} 应在 node-a`);
  assert.equal(shard.replica, null, `分片 ${shard.shardId} 不应有副本`);
}

const created = await expectStatus(await fetch(`${url}/sessions`, { method: 'POST', headers, body: '{}' }), 201, '创建会话（拉起该用户的 Codex 进程）');
const session = await created.json();
assert.ok(session.id, '会话 ID');
await expectStatus(await fetch(`${url}/state?threadId=${encodeURIComponent(session.id)}`, { headers }), 200, '读取会话状态');

// 只在独立 Compose 验收项目内，按真实文件属主写入；不增加线上测试接口。
const { user } = await (await expectStatus(await fetch(`${url}/auth/me`, { headers }), 200, '读取当前用户')).json();
assert.match(user.id, /^[a-f0-9-]{36}$/);
const seed = spawnSync('docker', ['compose', 'exec', '-T', 'node-a', 'node', '--input-type=module'], {
  encoding: 'utf8', input: `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawnSync } from 'node:child_process';
    import { userSpawn } from './server/modules/codex/launch.mjs';
    const directory = path.resolve('workspace/users', ${JSON.stringify(user.id)});
    const uid = fs.statSync(directory).uid;
    if (uid < 10001) throw new Error('验收要求真实用户 uid。');
    const launch = userSpawn(process.execPath, ['--input-type=module', '-e',
      "import fs from 'node:fs'; fs.mkdirSync('outputs', {recursive:true, mode:0o2770}); fs.writeFileSync('outputs/e2e-preview.html', '<html><body>安全预览验收</body></html>', {flag:'wx', mode:0o660});"], { uid, gid: uid, isolated: true });
    const result = spawnSync(launch.command, launch.args, { ...launch.options, cwd: directory, env: { PATH: process.env.PATH }, stdio: 'inherit' });
    process.exit(result.status ?? 1);
  `,
});
assert.equal(seed.status, 0, '维护容器写入 HTML 产物失败；不输出容器原始日志');
const issued = await expectStatus(await fetch(`${url}/previews`, { method: 'POST', headers, body: JSON.stringify({ path: 'outputs/e2e-preview.html' }) }), 200, '申请预览');
const preview = await issued.json();
const rendered = await expectStatus(await fetch(new URL(preview.url, url)), 200, '经 Caddy 读取匿名预览');
assert.equal(await rendered.text(), '<html><body>安全预览验收</body></html>');
assert.equal(rendered.headers.get('content-security-policy'), "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
assert.equal(rendered.headers.get('x-content-type-options'), 'nosniff');
assert.equal(rendered.headers.get('cache-control'), 'no-store');
assert.equal(rendered.headers.get('referrer-policy'), 'no-referrer');
assert.equal(rendered.headers.get('cross-origin-resource-policy'), 'same-origin');

assert.equal((await fetch(`${url}/sessions`, { method: 'POST', body: '{}' })).status, 401, '未登录应被拒绝');
assert.equal((await fetch(`${url}/state?threadId=${encodeURIComponent(session.id)}`, {
  headers: { authorization: 'Bearer invalid-token-for-e2e-check-000000' },
})).status, 401, '无效令牌应被拒绝');

console.log('端到端检查通过：就绪、登录、单节点拓扑（3 个分片都在 node-a、复制关闭）、会话创建、真实 uid 产物写入、Caddy 签名预览及安全头、拒绝未认证请求。');
