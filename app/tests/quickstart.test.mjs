import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { setup, parseSetup } from '../scripts/setup.mjs';
import { newAgent } from '../scripts/agent-new.mjs';
import { ctl, ctlArgs } from '../scripts/ctl.mjs';
import { expandCluster, parseCluster, enableCluster, waitReplicas } from '../scripts/cluster-enable.mjs';
import { deploy, parseDeploy } from '../scripts/deploy.mjs';
import { generateDeployEnv } from '../scripts/deploy-env.mjs';
import { readEnv, writeEnv, runProcess, childEnvironment, composeUp, waitReady, envRunArgs } from '../scripts/quickstart-lib.mjs';
import { clusterNodes, validateClusterSecrets } from '../server/modules/config/cluster.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { saveCredentials, readCredentials, clientDirectory } from '../client/modules/connection/credentials.mjs';
import { loadServerAddress } from '../client/modules/connection/index.mjs';

const password = 'temporary-test-password';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-quickstart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['agents', 'config']) fs.cpSync(new URL(`../${directory}`, import.meta.url), path.join(root, directory), { recursive: true });
  for (const file of ['.env.example', 'package.json', 'compose.yaml']) fs.copyFileSync(new URL(`../${file}`, import.meta.url), path.join(root, file));
  const calls = [], logs = [], answers = [];
  const context = { root, env: { SETUP_ADMIN_PASSWORD: password, FORCE_COLOR: '1', DEEPSEEK_API_KEY: 'test-provider-key', PATH: process.env.PATH },
    run: async (command, args, options) => { calls.push({ command, args, options }); return args.at(-1) === 'status' ? 'initialized\n' : ''; },
    portCheck: async port => { assert.equal(port, 4317); }, ready: async () => {}, log: text => logs.push(text),
    prompts: { ask: async () => { assert.ok(answers.length, '测试输入缺失'); return answers.shift(); }, close() {} } };
  return { ...context, calls, logs, answers };
}
async function configured(t) { const f = fixture(t); await setup(['--non-interactive', '--no-start'], f); return f; }

test('setup 参数仅允许明确的开关，拒绝秘密参数和重复参数', () => {
  assert.deepEqual(parseSetup(['--non-interactive', '--no-start']), { interactive: false, start: false, reconfigure: false, quiet: false });
  for (const args of [['--password', password], ['--no-start', '--no-start'], ['unknown']]) assert.throws(() => parseSetup(args), /用法/);
});
test('setup 非交互缺少密码或输入不合法时不写文件、不启动', async t => {
  for (const env of [{}, { SETUP_ADMIN_PASSWORD: 'short' }, { SETUP_ADMIN_PASSWORD: password, CODEX_MODEL: 'not-in-catalog' }, { SETUP_ADMIN_PASSWORD: password, SETUP_DOMAIN: 'https://example.com/path' }, { SETUP_ADMIN_PASSWORD: password, SETUP_ADMIN_USER: '../bad' }]) {
    const f = fixture(t); f.env = env;
    await assert.rejects(setup(['--non-interactive'], f), /SETUP_|CODEX_MODEL/);
    assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
    assert.equal(f.calls.length, 0);
  }
});
test('setup no-start 生成全部字段、0600、有效拓扑，管理员密码不落盘', async t => {
  const f = fixture(t); f.env.SETUP_DOMAIN = 'agent.example.com';
  await setup(['--non-interactive', '--no-start'], f);
  const values = readEnv(f.root), template = parseEnv(fs.readFileSync(path.join(f.root, '.env.example'), 'utf8'));
  assert.deepEqual(Object.keys(values).sort(), Object.keys(template).sort());
  validateClusterSecrets(values, clusterNodes(values));
  assert.equal(fs.statSync(path.join(f.root, '.env')).mode & 0o777, 0o600);
  assert.equal(values.CODEX_MODEL, 'deepseek/deepseek-flash');
  assert.equal(values.CONTAINER_APP_DIR, path.resolve(f.root));
  assert.equal(values.AGENT_ALLOWED_ORIGINS, 'http://127.0.0.1:4317,http://localhost:4317,https://agent.example.com');
  assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8').includes(password), false);
  assert.equal(f.calls.length, 0);
  const check = spawnSync(process.execPath, [new URL('../scripts/cluster-config.mjs', import.meta.url).pathname, 'check'], { cwd: f.root, encoding: 'utf8', env: { PATH: process.env.PATH, FORCE_COLOR: '1' } });
  assert.equal(check.status, 0, 'cluster-config.mjs check 应成功');
  assert.match(check.stdout, /集群配置检查通过/);
});
test('setup 已有配置逐字保留，不读取交互或执行命令', async t => {
  const f = await configured(t), before = fs.readFileSync(path.join(f.root, '.env'));
  await setup([], f);
  assert.ok(before.equals(fs.readFileSync(path.join(f.root, '.env'))));
  assert.equal(f.calls.length, 0);
  assert.match(f.logs.at(-1), /已配置；要重新生成请先备份并删除 .env/);
});
test('setup reconfigure 仅改模型项，保留全部部署凭据与其他配置', async t => {
  const f = await configured(t), before = readEnv(f.root);
  f.env.CODEX_MODEL = 'kimi/kimi-k2.7-code'; f.env.KIMI_API_KEY = 'another-test-provider-key';
  await setup(['--non-interactive', '--no-start', '--reconfigure-model'], f);
  const after = readEnv(f.root);
  assert.equal(after.CODEX_MODEL, 'kimi/kimi-k2.7-code');
  for (const key of Object.keys(before).filter(key => !['CODEX_MODEL', 'CODEX_MODEL_CATALOG_ENABLED', 'KIMI_API_KEY'].includes(key))) assert.ok(before[key] === after[key], `${key} 不应改变`);
});
test('setup 交互选择模型与隐藏输入，密码两次不一致不写入', async t => {
  const f = fixture(t), secretQuestions = [];
  f.answers.push('deepseek/deepseek-flash', '', '', '', password, 'different-password');
  const ask = f.prompts.ask; f.prompts.ask = async (label, options) => { if (options?.secret) secretQuestions.push(label); return ask(); };
  await assert.rejects(setup(['--no-start'], f), /两次密码不一致/);
  assert.equal(secretQuestions.length, 3);
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
});
test('setup 按顺序构建启动初始化，密码只进入 stdin，不进入子进程参数或环境', async t => {
  const f = fixture(t);
  await setup(['--non-interactive'], f);
  assert.deepEqual(f.calls.map(call => [call.command, call.args.slice(0, 3)]), [
    ['docker', ['compose', 'version']], ['bash', ['deploy/configure.sh']], ['docker', ['compose', 'up', '-d']], ['docker', ['compose', 'run', '--rm']],
  ]);
  const init = f.calls.at(-1);
  assert.equal(init.args[init.args.indexOf('--cap-add') + 1], 'DAC_READ_SEARCH');
  assert.ok(init.args.includes(`${f.root}/.env:${f.root}/.env:ro`));
  assert.equal(init.options.input, `admin\n${password}\n`);
  assert.deepEqual(init.args.slice(-3), ['scripts/maintenance.mjs', 'accounts', 'init']);
  for (const call of f.calls) {
    const exposed = JSON.stringify([call.args, call.options.env]);
    assert.equal(exposed.includes(password), false);
    assert.equal(exposed.includes(f.env.DEEPSEEK_API_KEY), false);
  }
  assert.equal(f.logs.join('\n').includes(password), false);
});
test('setup 启动检查失败不写入，不重试；no-start 不检查 Docker 和端口', async t => {
  const f = fixture(t); f.portCheck = async () => { throw new Error('4317 端口不可用'); };
  await assert.rejects(setup(['--non-interactive'], f), /4317/);
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
  assert.equal(f.calls.length, 1);
  await setup(['--non-interactive', '--no-start'], f);
  assert.equal(f.calls.length, 1);
});
test('setup 启动操作结果不确定时停止，不自动重发初始化', async t => {
  const f = fixture(t); let count = 0;
  f.run = async () => { if (++count === 4) throw new Error('结果待核对'); };
  await assert.rejects(setup(['--non-interactive'], f), /待核对/);
  assert.equal(count, 4); assert.equal(fs.existsSync(path.join(f.root, '.env')), true);
});
test('环境序列化保留美元符号，拒绝换行且不留下临时文件', async t => {
  const f = await configured(t), before = fs.readFileSync(path.join(f.root, '.env'));
  assert.throws(() => writeEnv(f.root, { AGENT_GATEWAY_KEY: "invalid'input" }), /AGENT_GATEWAY_KEY/);
  assert.ok(before.equals(fs.readFileSync(path.join(f.root, '.env'))));
  writeEnv(f.root, { TEST: 'a${HOME}$b' }); assert.equal(readEnv(f.root).TEST, 'a${HOME}$b');
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
});
test('agent:new 名称、通用模板、显示名称与引用校验；重复目录拒绝且原文件不变', t => {
  const f = fixture(t);
  for (const name of ['x', '../bad', 'Upper', 'a_b', 'x'.repeat(33), 'two words']) assert.throws(() => newAgent(name, f), /名称/);
  for (const name of ['my-agent', '12', '--']) {
    const definition = newAgent(name, f), file = path.join(f.root, 'agents', name, 'agent.json');
    const agent = new AgentDefinition(f.root, file);
    assert.equal(definition.agent.id, name); assert.equal(agent.definition.agent.name, '通用助手');
    assert.ok(agent.skills.length); assert.ok(agent.workflows.list().some(item => item.id === 'solve-task'));
    assert.equal(agent.definition.agent.tools.allow.includes('generate_image'), false);
    assert.ok(fs.existsSync(path.join(f.root, 'agents', name, 'workflows/README.md')));
    const before = fs.readFileSync(file);
    assert.throws(() => newAgent(name, f), /已存在/);
    assert.ok(before.equals(fs.readFileSync(file)));
  }
  assert.doesNotThrow(() => new AgentDefinition(f.root, path.join(f.root, 'agents/writing/agent.json')));
});
test('cluster:enable 新凭据校验通过、旧凭据不变、profiles 合并、只增不减', async t => {
  const f = await configured(t), before = readEnv(f.root); before.COMPOSE_PROFILES = 'remote-access,cluster,remote-access';
  const { values, added } = expandCluster(before, 'node-a,node-b');
  assert.deepEqual(added, ['node-b']); assert.equal(values.COMPOSE_PROFILES, 'remote-access,cluster');
  validateClusterSecrets(values, clusterNodes(values));
  for (const key of ['AGENT_NODE_KEY_A', 'AGENT_DB_PASSWORD', 'ETCD_ROOT_PASSWORD', 'AGENT_GATEWAY_KEY']) assert.ok(values[key] === before[key], key);
  assert.throws(() => expandCluster(values, 'node-a'), /只能增加/);
  const three = expandCluster(values, 'node-a,node-b,node-c'); validateClusterSecrets(three.values, clusterNodes(three.values));
  assert.deepEqual(three.added, ['node-c']); assert.deepEqual(expandCluster(three.values, 'node-a,node-b,node-c').added, []);
  assert.equal(parseCluster(['--yes', '--nodes', 'node-a,node-b']).yes, true);
  assert.throws(() => parseCluster(['--nodes', 'node-b,node-a']), /AGENT_CLUSTER_NODES/);
});
test('cluster:enable 默认确认可取消，拒绝 admin 门禁时不写配置', async t => {
  const f = await configured(t), before = fs.readFileSync(path.join(f.root, '.env'));
  f.answers.push('n'); await enableCluster([], f);
  assert.ok(before.equals(fs.readFileSync(path.join(f.root, '.env'))));
  await assert.rejects(enableCluster(['--yes'], { ...f, api: { request: async () => { throw new Error('需要 admin'); } } }), /admin/);
  assert.ok(before.equals(fs.readFileSync(path.join(f.root, '.env')))); assert.equal(f.calls.length, 0);
});
test('副本轮询必须三个分片全部有副本且追平；超时固定为 10 分钟', async () => {
  let time = 0, count = 0;
  const shards = Array.from({ length: 3 }, (_, shardId) => ({ shardId, replica: 'node-b', replica_ready: true }));
  await waitReplicas({ request: async () => ({ shards: ++count === 1 ? [{ ...shards[0], replica_ready: false }] : shards }) }, { now: () => time, wait: async ms => { time += ms; }, log() {} });
  assert.equal(count, 2);
  time = 0;
  await assert.rejects(waitReplicas({ request: async () => ({ shards: shards.map(s => ({ ...s, replica: null })) }) }, { now: () => time, wait: async ms => { time += ms; }, log() {} }), /10 分钟/);
  assert.equal(time, 600000);
});
test('ctl Compose 参数覆盖单节点、两节点、三节点、日志与账号；stop 不删数据', () => {
  assert.deepEqual(ctlArgs('down', [], {}, '/app'), ['compose', 'stop']);
  assert.deepEqual(ctlArgs('up', [], {}, '/app'), ['compose', 'up', '-d', '--wait']);
  assert.deepEqual(composeUp({ AGENT_CLUSTER_NODES: 'node-a,node-b' }), ['compose', '--profile', 'cluster', 'up', '-d', '--wait', 'node-a', 'node-b', 'caddy']);
  assert.deepEqual(ctlArgs('logs', ['node-a'], {}, '/app'), ['compose', 'logs', '-f', '--tail', '100', 'node-a']);
  assert.deepEqual(ctlArgs('status', [], {}, '/app'), ['compose', 'ps']);
  for (const [command, args] of [['init', []], ['add', ['bob', '--admin']], ['passwd', ['bob']], ['disable', ['bob']], ['list', []]]) {
    assert.deepEqual(ctlArgs(command, args, {}, '/app'), ['compose', 'run', '--rm', '--no-deps', '--cap-add', 'DAC_READ_SEARCH', '-v', '/app/.env:/app/.env:ro', '-T', 'node-a', 'node', 'scripts/maintenance.mjs', 'accounts', command, ...args]);
  }
  for (const [cmd, args] of [['down', ['-v']], ['add', ['bob', '--bad']], ['logs', ['--help']], ['disable', ['../bob']]]) assert.throws(() => ctlArgs(cmd, args, {}, '/app'));
});
test('ctl 密码只经 stdin；status 显示 waiting、replication 与版本；up 先构建新 Agent', async t => {
  const f = await configured(t); f.answers.push(password, password);
  await ctl(['add', 'bob', '--admin'], f);
  const call = f.calls.at(-1); assert.equal(call.options.input, `${password}\n`);
  assert.equal(JSON.stringify([call.args, call.options.env]).includes(password), false);
  await ctl(['status'], { ...f, fetchImpl: async () => ({ status: 503, json: async () => ({ status: 'not-ready', waiting: '副本准备中', replication: 'on' }) }) });
  assert.match(f.logs.join('\n'), /waiting.*副本准备中.*replication.*on/); assert.match(f.logs.join('\n'), /版本：1.0.0/);
  f.calls.length = 0; await ctl(['up'], f);
  assert.equal(f.calls[0].command, 'bash'); assert.equal(f.calls[0].args[0], 'deploy/configure.sh');
});
function upFixture(f, status = 'initialized\n') {
  const steps = [], run = f.run;
  f.isTTY = false;
  f.run = async (command, args, options) => {
    const step = command === 'bash' ? 'configure' : args.includes('accounts') ? args.at(-1) : 'up';
    steps.push(step);
    await run(command, args, options);
    if (step === 'status') {
      if (status instanceof Error) throw status;
      return status;
    }
    return '';
  };
  f.ready = async () => { steps.push('ready'); };
  return steps;
}
test('up 已初始化时只查询一次账号状态，不提示初始化，随后等待就绪', async t => {
  for (const isTTY of [false, true]) {
    const f = await configured(t), steps = upFixture(f);
    f.isTTY = isTTY;
    f.prompts = { ask: async () => assert.fail('已有账号不应询问'), close() { assert.fail('不应创建交互'); } };
    await ctl(['up'], f);
    assert.deepEqual(steps, ['configure', 'up', 'status', 'ready']);
    const status = f.calls.at(-1);
    assert.equal(status.command, 'docker');
    assert.deepEqual(status.args, envRunArgs(f.root, ['-T', 'node-a', 'node', 'scripts/maintenance.mjs', 'accounts', 'status'], readEnv(f.root)));
    assert.equal(status.options.capture, true);
    assert.equal(status.options.input, undefined);
  }
});
test('up 未初始化且是 TTY 时先查询、隐藏输入两次、经 stdin 初始化，再等就绪', async t => {
  for (const username of ['', 'operator']) {
    const f = await configured(t), steps = upFixture(f, 'uninitialized\n'), questions = [];
    f.isTTY = true;
    f.answers.push(username, password, password);
    const ask = f.prompts.ask;
    f.prompts.ask = async (label, options) => { steps.push('ask'); questions.push({ label, secret: options?.secret }); return ask(); };
    f.prompts.close = () => steps.push('close');
    await ctl(['up'], f);
    assert.deepEqual(steps, ['configure', 'up', 'status', 'ask', 'ask', 'ask', 'close', 'init', 'ready']);
    assert.match(questions[0].label, /admin/);
    assert.deepEqual(questions.map(q => q.secret), [undefined, true, true]);
    const init = f.calls.at(-1);
    assert.equal(init.command, 'docker');
    assert.deepEqual(init.args, ctlArgs('init', [], readEnv(f.root), f.root));
    assert.ok(init.options.input === `${username || 'admin'}\n${password}\n`, '用户名与密码只能经 stdin 传入');
    for (const call of f.calls) assert.equal(JSON.stringify([call.args, call.options.env]).includes(password), false);
    assert.equal(f.logs.join('\n').includes(password), false);
    assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8').includes(password), false);
    assert.ok(f.logs.includes('还没有管理员账号，现在创建'));
  }
});
test('up 未初始化且非 TTY 时立即拒绝，不读取输入、不初始化、不等待就绪', async t => {
  const f = await configured(t), steps = upFixture(f, 'uninitialized\n');
  f.prompts.ask = async () => assert.fail('非 TTY 不应读取输入');
  await assert.rejects(ctl(['up'], f), error => /npm run auth:init/.test(error.message) && /npm run setup -- --non-interactive/.test(error.message) && /SETUP_ADMIN_PASSWORD/.test(error.message));
  assert.deepEqual(steps, ['configure', 'up', 'status']);
});
for (const [name, status] of [['命令失败', new Error('结果待核对')], ['空输出', ''], ['未知输出', 'unknown\n'], ['混杂输出', 'initialized\nuninitialized\n']]) {
  test(`up 账号状态${name}时提示 status 核对，不重试、不初始化、不等待`, async t => {
    const f = await configured(t), steps = upFixture(f, status);
    f.isTTY = true;
    f.prompts.ask = async () => assert.fail('状态不明不应读取输入');
    await assert.rejects(ctl(['up'], f), /npm run status/);
    assert.deepEqual(steps, ['configure', 'up', 'status']);
  });
}
test('up 初始化密码不一致时关闭交互，不初始化、不等待就绪', async t => {
  const f = await configured(t), steps = upFixture(f, 'uninitialized\n');
  f.isTTY = true;
  f.answers.push('', password, 'different-password');
  f.prompts.close = () => steps.push('close');
  await assert.rejects(ctl(['up'], f), /两次密码不一致/);
  assert.deepEqual(steps, ['configure', 'up', 'status', 'close']);
});
test('up 初始化失败时停止，不重试、不等待就绪', async t => {
  const f = await configured(t), steps = upFixture(f, 'uninitialized\n'), run = f.run;
  f.isTTY = true;
  f.answers.push('', password, password);
  f.run = async (...args) => {
    const result = await run(...args);
    if (args[1].at(-1) === 'init') throw new Error('结果待核对');
    return result;
  };
  await assert.rejects(ctl(['up'], f), /待核对/);
  assert.deepEqual(steps, ['configure', 'up', 'status', 'init']);
});
test('子进程调用以 stdin 管道写入且抑制错误原文，无隐式环境继承', async () => {
  let captured, stdin = '';
  const spawnImpl = (command, args, options) => {
    captured = { command, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, done) { stdin += chunk; done(); } });
    queueMicrotask(() => { child.stderr.write(password); child.emit('close', 1); });
    return child;
  };
  await assert.rejects(runProcess('docker', ['compose', 'run'], { env: childEnvironment({ SETUP_ADMIN_PASSWORD: password, DATABASE_URL: password, FORCE_COLOR: '1' }), input: password, spawnImpl }), error => !error.message.includes(password));
  assert.equal(stdin, password); assert.equal(JSON.stringify(captured).includes(password), false);
  assert.equal(captured.options.env.FORCE_COLOR, '1');
});
test('Compose CLI 在宿主独立目录保存凭据，默认入口无需手设环境变量', t => {
  const f = fixture(t), url = loadServerAddress({}, f.root);
  assert.equal(url, 'http://127.0.0.1:4317');
  saveCredentials(f.root, { url, token: 'a'.repeat(43) });
  assert.equal(path.basename(clientDirectory(f.root)), '.cli');
  assert.ok(readCredentials(f.root, url).token.length === 43);
  assert.equal(fs.statSync(clientDirectory(f.root)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(clientDirectory(f.root), 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.root, '.data')), false);
});
test('deploy 默认按 check、存在检查、init-env、deploy、账号状态执行；已有配置跳过 init-env', async t => {
  for (const exists of ['missing', 'configured']) {
    const f = await configured(t), calls = [];
    await deploy(['--host', 'root@example.com'], { ...f, run: async (command, args) => { calls.push([command, args]); return command === 'ssh' ? args.at(-1).includes('printf configured') ? exists : 'uninitialized\n' : ''; } });
    assert.deepEqual(calls.filter(([cmd]) => cmd === 'bash').map(([,args]) => args[1]), exists === 'missing' ? ['check', 'init-env', 'deploy'] : ['check', 'deploy']);
    assert.match(f.logs.join('\n'), /npm run deploy -- --host root@example.com auth-init/);
  }
});
test('deploy 透传子命令，拒绝危险 SSH 目标与路径', async t => {
  const f = await configured(t);
  await deploy(['--host', 'root@example.com', 'user', '--', 'add', 'bob'], f);
  assert.deepEqual(f.calls[0].args, ['deploy/remote.sh', 'user', '--', 'add', 'bob']);
  for (const host of ['-oProxyCommand=bad', 'a;bad', 'a b']) assert.throws(() => parseDeploy(['--host', host]), /SSH/);
  assert.throws(() => parseDeploy(['--host', 'example.com'], { APP_DIR: '/srv/../bad' }), /APP_DIR/);
});
test('ready 只轮询只读请求，固定两分钟超时', async () => {
  let time = 0;
  await assert.rejects(waitReady({}, { fetchImpl: async () => ({ status: 503 }), now: () => time, wait: async ms => { time += ms; }, log() {} }), /超时/);
  assert.equal(time, 120000);
});
test('目录权限由一次性容器统一准备，不依赖宿主 root，不递归覆盖用户文件', () => {
  const source = fs.readFileSync(new URL('../deploy/configure.sh', import.meta.url), 'utf8');
  assert.match(source, /docker compose run --rm --no-deps --user 0 -T -v "\$PWD:\/prepare"/);
  assert.match(source, /chown 0:1000 "\$1" && chmod 2770/);
  assert.doesNotMatch(source, /id -u|chown -R|chmod -R|DAC_OVERRIDE/);
  assert.match(source, /prepare "nodes\/\$node\/\$directory"/);
  const bootstrap = fs.readFileSync(new URL('../deploy/bootstrap.sh', import.meta.url), 'utf8');
  assert.match(bootstrap, /docker compose run .*--user 0 .*\/prepare-nodes/);
});

test('workbench 返回可选显示名称，旧 Agent 仍回退到 id，认证门禁保持生效', async t => {
  const { fixedAccounts, httpFixture, request } = await import('./accounts-fixture.mjs');
  const f = fixture(t); newAgent('display-agent', f);
  for (const name of ['display-agent', 'writing']) {
    const agent = new AgentDefinition(f.root, path.join(f.root, 'agents', name, 'agent.json'));
    const http = httpFixture(fixedAccounts(), { config: { launch: {}, deployment: {}, agent } });
    assert.equal((await request(http, '/workbench')).statusCode, 401);
    const response = await request(http, '/workbench', { token: 'unit-token' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.agent.name || response.body.agent.id, name === 'display-agent' ? '通用助手' : 'writing-assistant');
    await http.close();
  }
});
test('日志流跨 chunk 脱敏，stdout 与 stderr 都不泄露已知凭据', async () => {
  const { createLogRedactor } = await import('../server/modules/config/index.mjs');
  let text = '';
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write('开始 ' + password.slice(0, 5)); child.stdout.write(password.slice(5) + '\n');
      child.stderr.write(password.slice(0, 10)); child.stderr.write(password.slice(10)); child.emit('close', 0);
    });
    return child;
  };
  await runProcess('docker', ['compose', 'logs'], { spawnImpl, redact: createLogRedactor(password), output: chunk => { text += chunk; } });
  assert.equal(text.includes(password), false); assert.match(text, /开始 \[REDACTED\]/); assert.equal(text.split('[REDACTED]').length, 3);
});
test('FORCE_COLOR 下 shell 捕获的拓扑仍是纯文本', async t => {
  const f = await configured(t);
  const result = spawnSync(process.execPath, [new URL('../scripts/cluster-config.mjs', import.meta.url).pathname, 'nodes'], { cwd: f.root, encoding: 'utf8', env: { PATH: process.env.PATH, FORCE_COLOR: '1' } });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'node-a\n'); assert.equal(result.stdout.includes('\u001b'), false);
});
test('脚手架统一使用 up 与 down，不提供数据库和网关的单独启停命令', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts.up, 'node scripts/ctl.mjs up');
  assert.equal(pkg.scripts.down, 'node scripts/ctl.mjs down');
  assert.equal(pkg.scripts['db:up'], undefined);
  assert.equal(pkg.scripts['gateway:up'], undefined);
  assert.equal(pkg.scripts['db:down'], undefined); assert.equal(pkg.scripts['gateway:down'], undefined);
});
test('cluster:enable 经 admin 检查后写配置、构建、按新拓扑启动并验证副本', async t => {
  const f = await configured(t), events = [];
  const run = f.run;
  await enableCluster(['--yes', '--nodes', 'node-a,node-b'], { ...f,
    api: { request: async route => { assert.equal(route, '/cluster'); events.push('admin'); } },
    run: async (...args) => { events.push(args[0]); return run(...args); },
    ready: async () => { events.push('ready'); }, wait: async () => { events.push('replicas'); },
  });
  assert.deepEqual(events, ['admin', 'bash', 'docker', 'ready', 'replicas']);
  assert.equal(readEnv(f.root).AGENT_CLUSTER_NODES, 'node-a,node-b');
  validateClusterSecrets(readEnv(f.root), ['node-a', 'node-b']);
  assert.deepEqual(f.calls.at(-1).args, ['compose', '--profile', 'cluster', 'up', '-d', '--wait', 'node-a', 'node-b', 'caddy']);
  for (const call of f.calls) assert.equal(JSON.stringify([call.args, call.options.env]).includes(password), false);
});
test('cluster:enable 修改后外部操作失败立即停止，保留现场供人工核对', async t => {
  const f = await configured(t); let calls = 0;
  await assert.rejects(enableCluster(['--yes'], { ...f, api: { request: async () => ({}) }, run: async () => { calls++; throw new Error('结果待核对'); } }), /待核对/);
  assert.equal(calls, 1); assert.equal(readEnv(f.root).AGENT_CLUSTER_NODES, 'node-a,node-b,node-c');
});
test('status 所需的 /ready 对单节点和集群明确返回 replication 状态', async () => {
  const { fixedAccounts, httpFixture, request } = await import('./accounts-fixture.mjs');
  for (const replication of ['off', 'on']) {
    const http = httpFixture(fixedAccounts(), { config: { launch: {}, deployment: {}, sharding: { replication: { status: async () => ({ replication, waiting: null, shards: [] }) } } } });
    const result = await request(http, '/ready');
    assert.equal(result.statusCode, 200); assert.equal(result.body.replication, replication);
    await http.close();
  }
});
test('setup 缺少 Docker Compose 时给出中文修复提示，配置尚未写入', async t => {
  const f = fixture(t);
  f.run = async () => { throw new Error('外部命令失败'); };
  await assert.rejects(setup(['--non-interactive'], f), /Docker Compose 不可用.*docker compose version/);
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
});


test('CLI 不迁移旧凭据，提示重新登录；已有凭据目录收紧到 0700', t => {
  const f = fixture(t), url = loadServerAddress({}, f.root);
  fs.mkdirSync(path.join(f.root, '.env.client'));
  const old = path.join(f.root, '.env.client/credentials.json');
  fs.writeFileSync(old, JSON.stringify({ url, token: 'a'.repeat(43) }), { mode: 0o600 });
  assert.throws(() => readCredentials(f.root, url), /npm run login/);
  assert.ok(fs.existsSync(old));
  assert.equal(fs.existsSync(path.join(f.root, '.cli/credentials.json')), false);
  fs.chmodSync(path.join(f.root, '.cli'), 0o755);
  saveCredentials(f.root, { url, token: 'b'.repeat(43) });
  assert.equal(fs.statSync(path.join(f.root, '.cli')).mode & 0o777, 0o700);
});
test('CLI 凭据目录显式排除 Git、Docker 与远端同步', () => {
  for (const file of ['.gitignore', '.dockerignore']) assert.ok(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n').includes('.cli/'));
  const remote = fs.readFileSync(new URL('../deploy/remote.sh', import.meta.url), 'utf8');
  for (const line of remote.split('\n').filter(line => line.startsWith('excludes=') || line.startsWith('rsync -a') || line.startsWith(' rsync -a'))) assert.match(line, /--exclude=\/\.cli\//);
});

function outputProcess(chunks, code, beforeClose = () => {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, done) { done(); } });
    queueMicrotask(() => {
      for (const [channel, text] of chunks) child[channel].write(text);
      beforeClose(); child.emit('close', code);
    });
    return child;
  };
}
test('外部命令 quiet 成功无输出，失败仍显示已脱敏的最后 40 行', async () => {
  const { createLogRedactor } = await import('../server/modules/config/index.mjs');
  for (const code of [0, 1]) {
    let text = '';
    const chunks = Array.from({ length: 55 }, (_, i) => [i % 2 ? 'stderr' : 'stdout', `行${i + 1} ${password}\n`]);
    const promise = runProcess('docker', [], { quiet: true, output: chunk => { text += chunk; }, redact: createLogRedactor(password), spawnImpl: outputProcess(chunks, code) });
    if (code) await assert.rejects(promise, /退出码 1/); else await promise;
    assert.equal(text.includes(password), false);
    assert.equal(text, code ? Array.from({ length: 40 }, (_, i) => `行${i + 16} [REDACTED]\n`).join('') : '');
  }
});
test('外部命令失败尾部保留跨块、跨行凭据脱敏和无换行末行', async () => {
  const { createLogRedactor } = await import('../server/modules/config/index.mjs');
  let text = '';
  const secret = 'test-line-one\ntest-line-two';
  const chunks = [['stdout', '开始\n' + secret.slice(0, 16)], ['stdout', secret.slice(16) + '\n末行']];
  await assert.rejects(runProcess('docker', [], { quiet: true, output: chunk => { text += chunk; }, redact: createLogRedactor(secret), spawnImpl: outputProcess(chunks, 1) }));
  assert.equal(text, '开始\n[REDACTED]\n末行');
});
for (const command of ['setup', 'up', 'cluster:enable']) {
  test(`${command} 默认实时脱敏，quiet 只显示步骤，失败尾部可见`, async t => {
    for (const quiet of [false, true]) for (const code of [0, 1]) {
      const f = command === 'setup' ? fixture(t) : await configured(t);
      let text = '', calls = 0, streamed = false;
      f.output = chunk => { text += chunk; };
      f.api = { request: async () => ({}) }; f.wait = async () => {};
      f.run = async (binary, args, options) => {
        calls++;
        if (args.includes('accounts') && args.at(-1) === 'status') return 'initialized\n';
        const values = fs.existsSync(path.join(f.root, '.env')) ? readEnv(f.root) : {};
        const secrets = [password, f.env.DEEPSEEK_API_KEY, ...Object.entries(values).filter(([key, value]) => /KEY|PASSWORD|TOKEN|SECRET|DATABASE_URL|REDIS_URL/i.test(key) && value).map(([, value]) => value)];
        const chunks = secrets.flatMap(secret => [['stdout', secret.slice(0, 4)], ['stdout', secret.slice(4) + '\n'], ['stderr', secret.slice(0, 6)], ['stderr', secret.slice(6) + '\n']]);
        chunks.push(['stdout', '命令进度\n']);
        const result = await runProcess(binary, args, { ...options, spawnImpl: outputProcess(chunks, code, () => { streamed = text.includes('命令进度'); }) });
        for (const secret of secrets) assert.equal(text.includes(secret), false, '已知凭据不得出现在终端');
        return result;
      };
      const flags = quiet ? ['--quiet'] : [];
      const promise = command === 'setup' ? setup(['--non-interactive', ...flags], f) : command === 'up' ? ctl(['up', ...flags], f) : enableCluster(['--yes', ...flags], f);
      if (code) { await assert.rejects(promise); assert.equal(calls, 1); } else await promise;
      assert.ok(calls > 0, 'quiet 必须实际执行命令');
      assert.equal(streamed, !quiet);
      assert.equal(text.includes(password), false); assert.equal(text.includes(f.env.DEEPSEEK_API_KEY), false);
      assert.equal(text.includes('命令进度'), !quiet || code !== 0);
      assert.ok(f.logs.length > 0);
    }
  });
}


test('真实子进程 stdout、stderr 跨块脱敏，quiet 失败只返回最后 40 行', async () => {
  const { createLogRedactor } = await import('../server/modules/config/index.mjs');
  const script = `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const { secret, code } = JSON.parse(input);
    process.stdout.write(secret.slice(0, 5));
    await new Promise(resolve => setImmediate(resolve));
    process.stdout.write(secret.slice(5) + '\\n');
    process.stderr.write(secret.slice(0, 7));
    await new Promise(resolve => setImmediate(resolve));
    process.stderr.write(secret.slice(7) + '\\n');
    for (let i = 1; i <= 45; i++) process.stdout.write('进度' + i + '\\n');
    process.exitCode = code;
  `;
  for (const [quiet, code] of [[false, 0], [true, 0], [true, 1]]) {
    let text = '';
    const promise = runProcess(process.execPath, ['--input-type=module', '-e', script], {
      input: JSON.stringify({ secret: password, code }), quiet, redact: createLogRedactor(password), output: chunk => { text += chunk; },
    });
    if (code) await assert.rejects(promise, /退出码 1/); else await promise;
    assert.equal(text.includes(password), false);
    if (!quiet) { assert.equal(text.split('[REDACTED]').length, 3); assert.match(text, /进度45/); }
    else if (!code) assert.equal(text, '');
    else {
      assert.equal(text.trimEnd().split('\n').length, 40);
      assert.match(text, /进度45/); assert.doesNotMatch(text, /进度1\n/);
    }
  }
});

test('up 自动补齐预览密钥：原子写入 0600、保留其他配置、重复运行保留密钥且日志脱敏', async t => {
  const f = await configured(t), values = readEnv(f.root);
  assert.match(values.AGENT_PREVIEW_SECRET, /^[a-f0-9]{64}$/);
  delete values.AGENT_PREVIEW_SECRET; writeEnv(f.root, values);
  const before = fs.statSync(path.join(f.root, '.env'));
  f.run = async (command, args, options) => {
    const secret = readEnv(f.root).AGENT_PREVIEW_SECRET;
    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.equal(options.redact?.(secret) ?? '[REDACTED]', '[REDACTED]');
    return args.at(-1) === 'status' ? 'initialized\n' : '';
  };
  await ctl(['up'], f);
  const after = readEnv(f.root), stat = fs.statSync(path.join(f.root, '.env'));
  assert.notEqual(stat.ino, before.ino, '使用原子替换而非原地覆写');
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, before.uid);
  assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'AGENT_PREVIEW_SECRET')), values);
  await ctl(['up'], f);
  assert.ok(readEnv(f.root).AGENT_PREVIEW_SECRET === after.AGENT_PREVIEW_SECRET, '补齐不得轮换现有密钥');
  assert.equal(f.logs.join('\n').includes(after.AGENT_PREVIEW_SECRET), false);
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
});
