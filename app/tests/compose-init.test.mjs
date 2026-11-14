import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePrepareEnvironment, prepareDirectories, copyNodeIdentities, prepare } from '../scripts/compose-init.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function environment(nodes = 'node-a') {
  const env = { CONTAINER_APP_DIR: '/srv/agent', AGENT_CLUSTER_NODES: nodes };
  for (const key of ['AGENT_DB_PASSWORD', 'REDIS_PASSWORD', 'ETCD_ROOT_PASSWORD', 'ETCD_HEALTH_PASSWORD', 'AGENT_GATEWAY_KEY', 'AGENT_PREVIEW_SECRET']) env[key] = 'test-only-value';
  for (const suffix of ['A', 'B', 'C']) {
    env[`AGENT_NODE_KEY_${suffix}`] = 'test-only-node-key-123456789';
    env[`AGENT_NODE_KEY_${suffix}_HASH`] = createHash('sha256').update(env[`AGENT_NODE_KEY_${suffix}`]).digest('hex');
    env[`AGENT_NODE_${suffix}_DB_PASSWORD`] = 'test-only-database-password';
    env[`ETCD_NODE_${suffix}_PASSWORD`] = 'test-only-value';
  }
  return env;
}

test('prepare：必填变量一次列全且不含值；路径必须绝对，节点凭据按拓扑校验', () => {
  const required = ['AGENT_DB_PASSWORD', 'REDIS_PASSWORD', 'AGENT_GATEWAY_KEY', 'ETCD_ROOT_PASSWORD', 'ETCD_HEALTH_PASSWORD', 'ETCD_NODE_A_PASSWORD', 'CONTAINER_APP_DIR', 'AGENT_PREVIEW_SECRET', 'AGENT_NODE_KEY_A', 'AGENT_NODE_KEY_A_HASH', 'AGENT_NODE_A_DB_PASSWORD'];
  assert.throws(() => validatePrepareEnvironment({ UNRELATED: '不能输出的测试值' }), error => {
    for (const name of required) assert.ok(error.message.includes(name), name);
    assert.match(error.message, /先运行配置向导或 npm run setup/);
    assert.equal(error.message.includes('不能输出的测试值'), false);
    return true;
  });
  for (const name of required) assert.throws(() => validatePrepareEnvironment({ ...environment(), [name]: ' ' }), new RegExp(name));
  assert.throws(() => validatePrepareEnvironment({ ...environment(), CONTAINER_APP_DIR: 'relative' }), /CONTAINER_APP_DIR.*绝对路径/);
  for (const nodes of ['node-a', 'node-a,node-b', 'node-a,node-b,node-c']) assert.deepEqual(validatePrepareEnvironment(environment(nodes)), nodes.split(','));
  assert.throws(() => validatePrepareEnvironment({ ...environment('node-a,node-b'), ETCD_NODE_B_PASSWORD: '' }), /ETCD_NODE_B_PASSWORD/);
  assert.throws(() => validatePrepareEnvironment({ ...environment(), AGENT_CLUSTER_NODES: '' }), /AGENT_CLUSTER_NODES/);
});

test('prepare：重复准备目录不改用户文件，仅设父目录 2770 与 0:1000', t => {
  const root = fixture(t), owners = [], modes = [];
  // 本机文件系统可能清除 setgid 位；精确检查系统调用参数，真实 uid 与 setgid 由 Linux CI 验证。
  const chown = (file, uid, gid) => owners.push([path.relative(root, file), uid, gid]);
  const chmod = (file, mode) => { modes.push([path.relative(root, file), mode]); fs.chmodSync(file, mode); };
  prepareDirectories(root, ['node-a', 'node-b'], { chown, chmod });
  const user = path.join(root, 'nodes/node-a/workspace/user');
  fs.writeFileSync(user, '保留内容', { mode: 0o600 });
  prepareDirectories(root, ['node-a', 'node-b'], { chown, chmod });
  assert.equal(fs.readFileSync(user, 'utf8'), '保留内容');
  assert.equal(fs.statSync(user).mode & 0o777, 0o600);
  for (const name of ['.data', '.runs', 'workspace', 'backups', '.data/gateway', 'nodes/node-a/.data', 'nodes/node-b/.runs', 'nodes/node-b/workspace', 'backups/node-b']) {
    assert.ok(modes.some(entry => entry[0] === name && entry[1] === 0o2770), name);
    assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o770, name);
    assert.ok(owners.some(entry => entry[0] === name && entry[1] === 0 && entry[2] === 1000), name);
  }
  assert.equal(fs.existsSync(path.join(root, 'nodes/node-c')), false);
});

test('prepare：拒绝数据目录及中间父路径的符号链接，拒绝普通文件', t => {
  for (const name of ['.data', '.data/gateway', 'nodes', 'nodes/node-a', 'nodes/node-a/.data', 'backups/node-a']) {
    const root = fixture(t), outside = fixture(t), target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target);
    assert.throws(() => prepareDirectories(root, ['node-a'], { chown() {} }), /目录不能是文件或符号链接/);
    assert.deepEqual(fs.readdirSync(outside), []);
  }
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.data'), '保留');
  assert.throws(() => prepareDirectories(root, ['node-a'], { chown() {} }), /目录不能是文件或符号链接/);
});

test('migrate：身份复制幂等、权限 0600，不一致和符号链接均拒绝', t => {
  const root = fixture(t), nodes = ['node-a', 'node-b', 'node-c'];
  for (const node of nodes) fs.mkdirSync(path.join(root, node, '.data'), { recursive: true });
  const source = path.join(root, 'node-a/.data/identity.json'), target = path.join(root, 'node-b/.data/identity.json');
  fs.writeFileSync(source, '{"instanceId":"测试身份"}\n', { mode: 0o600 });
  copyNodeIdentities(root, nodes);
  copyNodeIdentities(root, nodes);
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  fs.writeFileSync(target, '不同身份');
  assert.throws(() => copyNodeIdentities(root, nodes), /节点部署身份不一致/);
  assert.equal(fs.readFileSync(target, 'utf8'), '不同身份');
  fs.unlinkSync(target); fs.symlinkSync(source, target);
  assert.throws(() => copyNodeIdentities(root, nodes), /身份文件不能是链接/);
});

test('prepare：先校验再落盘，只用传入环境生成无密钥配置且可重复执行', t => {
  const root = fixture(t);
  assert.throws(() => prepare(root, {}), /缺少必填变量/);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.cpSync(new URL('../config/', import.meta.url), path.join(root, 'config'), { recursive: true });
  // 故意放置不可解析为配置的目录，若读取宿主 .env 就会报错。
  fs.mkdirSync(path.join(root, '.env'));
  t.mock.method(fs, 'chownSync', () => {});
  const env = { ...environment(), AGENT_GATEWAY_KEY: 'sk-bf-test-only-gateway', DEEPSEEK_API_KEY: 'test-only-provider', CODEX_MODEL: 'deepseek/deepseek-flash' };
  prepare(root, env);
  const config = path.join(root, '.data/gateway/config.json'), before = fs.readFileSync(config, 'utf8');
  assert.equal(before.includes(env.AGENT_GATEWAY_KEY), false);
  assert.equal(before.includes(env.DEEPSEEK_API_KEY), false);
  assert.match(before, /env.DEEPSEEK_API_KEY/);
  prepare(root, env);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.data/gateway/enabled-providers.json'))), ['deepseek']);
  fs.unlinkSync(config);
  const outside = path.join(root, '保留文件'); fs.writeFileSync(outside, '不改动');
  fs.symlinkSync(outside, config);
  assert.throws(() => prepare(root, env), /网关配置必须是普通文件/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '不改动');
});
