import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, containerDirectory } from '../scripts/setup.mjs';
import { decodeBootstrap } from '../server/modules/accounts/bootstrap.mjs';
import { verifyPassword } from '../server/modules/accounts/password.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'container-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['compose.yaml', '.env.example']) fs.copyFileSync(new URL(`../${file}`, import.meta.url), path.join(root, file));
  fs.cpSync(new URL('../config', import.meta.url), path.join(root, 'config'), { recursive: true });
  const logs = [], calls = [];
  return { root, logs, calls, env: { HOST_APP_DIR: root, SETUP_ADMIN_PASSWORD: 'container-test-password', CODEX_MODEL: 'deepseek/deepseek-flash', DEEPSEEK_API_KEY: 'test-only-provider' },
    log: line => logs.push(line), output: line => logs.push(line),
    run: async () => assert.fail('容器向导不能调用 Docker'), portCheck: async () => assert.fail('容器向导不能检查端口'),
    privilege: { getuid: () => 0, stat: file => { calls.push(['stat', file]); return { uid: 1234, gid: 2345 }; },
      setgroups: value => calls.push(['groups', value]), setgid: value => calls.push(['gid', value]), setuid: value => calls.push(['uid', value]) } };
}

test('容器向导拒绝缺失、相对或没有 compose.yaml 的 HOST_APP_DIR', async t => {
  for (const value of [undefined, 'relative', path.join(fixture(t).root, 'missing')]) {
    const f = fixture(t); f.env.HOST_APP_DIR = value;
    await assert.rejects(setup(['--container', '--non-interactive'], f), /请在 app 目录下运行 docker compose run --rm setup/);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
  }
});
test('容器向导按目录属主降权，root 挂载属主保持 root', t => {
  for (const uid of [1234, 0]) {
    const f = fixture(t); f.privilege.stat = () => ({ uid, gid: 2345 });
    assert.equal(containerDirectory(f.env, f.privilege), f.root);
    assert.deepEqual(f.calls, [['groups', []], ['gid', 2345], ['uid', uid]]);
  }
});
for (const answer of ['y', 'N', '']) test(`容器向导国内源回答 ${answer || '回车'}、路径与结束说明`, async t => {
  const f = fixture(t), questions = [], answers = ['', '', '', '', f.env.SETUP_ADMIN_PASSWORD, f.env.SETUP_ADMIN_PASSWORD, answer];
  f.prompts = { ask: async label => { questions.push(label); return answers.shift(); }, close() {} };
  // root 参数与 HOST_APP_DIR 不同，确认容器路径才是配置与写入依据。
  const values = await setup(['--container'], { ...f, root: '/nonexistent' });
  assert.equal(values.CONTAINER_APP_DIR, f.root);
  assert.equal(values.NPM_REGISTRY, answer === 'y' ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org');
  assert.equal(values.APT_MIRROR, answer === 'y' ? 'http://mirrors.aliyun.com' : '');
  assert.equal(questions.at(-1), '构建镜像时使用国内 npm/apt 镜像源？[y/N]');
  assert.equal(answers.length, 0);
  assert.deepEqual(f.calls.slice(1), [['groups', []], ['gid', 2345], ['uid', 1234]]);
  assert.equal(fs.statSync(path.join(f.root, '.env')).mode & 0o777, 0o600);
  for (const text of ['docker compose up -d', '1 个镜像', 'PostgreSQL、Redis、网关、etcd、Caddy、Node 基础镜像', '600 MB', '只有第一次需要', 'README']) assert.ok(f.logs.join('\n').includes(text), text);
  assert.doesNotMatch(values.AGENT_ADMIN_BOOTSTRAP, /\$/);
  const decoded = decodeBootstrap(values.AGENT_ADMIN_BOOTSTRAP);
  assert.equal(decoded.username, 'admin');
  assert.ok(await verifyPassword(f.env.SETUP_ADMIN_PASSWORD, decoded.hash));
  const files = fs.readdirSync(f.root, { recursive: true }).filter(name => fs.statSync(path.join(f.root, name)).isFile());
  for (const name of files) assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8').includes(f.env.SETUP_ADMIN_PASSWORD), false);
  assert.equal(JSON.stringify([f.logs, f.calls]).includes(f.env.SETUP_ADMIN_PASSWORD), false);
});
test('容器非交互通过 SETUP_CN_MIRROR 开启国内源', async t => {
  const f = fixture(t); f.env.SETUP_CN_MIRROR = '1';
  const values = await setup(['--container', '--non-interactive'], f);
  assert.equal(values.NPM_REGISTRY, 'https://registry.npmmirror.com');
  assert.equal(values.APT_MIRROR, 'http://mirrors.aliyun.com');
  assert.throws(() => decodeBootstrap('invalid$secret'), /AGENT_ADMIN_BOOTSTRAP.*格式/);
});
test('setup 服务权限、profile、固定镜像与 PWD 默认值约束', () => {
  const source = fs.readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  const body = source.split('  setup:\n')[1]?.split(/^  \w[^\n]*:\n/m)[0];
  assert.ok(body);
  const base = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').match(/^FROM (.+)$/m)[1];
  assert.match(base, /@sha256:[a-f0-9]{64}$/);
  assert.ok(body.includes(`image: ${base}`));
  for (const text of ['profiles: [setup]', 'network_mode: none', 'cap_drop: [ALL]', 'cap_add: [SETUID, SETGID]', 'user: "0:0"', 'no-new-privileges:true', '".:${PWD:-/nonexistent}"', 'working_dir: ${PWD:-/nonexistent}', 'HOST_APP_DIR: ${PWD:-/nonexistent}', 'entrypoint: ["node", "scripts/setup.mjs", "--container"]', 'command: []']) assert.ok(body.includes(text), text);
  assert.doesNotMatch(source, /:\?/);
  assert.equal([...source.matchAll(/\$\{PWD[^}]*\}/g)].length, 3);
  assert.doesNotMatch(source.replaceAll('${PWD:-/nonexistent}', ''), /\bPWD\b/);
});

test('容器向导保留 WSL 的 Windows 磁盘检查', async t => {
  const f = fixture(t); f.env.HOST_APP_DIR = '/mnt/c/project/app';
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', target => target === '/mnt/c/project/app/compose.yaml' || exists(target));
  await assert.rejects(setup(['--container', '--non-interactive'], { ...f, platform: 'linux', procVersion: 'Linux Microsoft WSL2' }), /仓库在 Windows 磁盘/);
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
});
