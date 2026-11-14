import { fixedAccounts } from './accounts-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { loadModelRegistry, validateRegistry, fallbackWarnings } from '../server/modules/gateway/index.mjs';
import { createModelRouter } from '../server/modules/gateway/router.mjs';
import { buildAppServerLaunch } from '../server/modules/codex/launch.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { defineWorkflows } from '../server/modules/workflows/index.mjs';
import { budgetConfig } from '../server/modules/usage/config.mjs';
import { UsageService } from '../server/modules/usage/index.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { createHttpService } from '../server/modules/http/index.mjs';
import { runChat } from '../client/modules/chat/index.mjs';
import { rig, until, tempRoot, installToolFixture } from './helpers.mjs';
import { setup as mediaRig, png } from './media-fixture.mjs';

const registry = loadModelRegistry(path.resolve(import.meta.dirname, '..'));
const environment = { AGENT_GATEWAY_KEY: 'sk-bf-test', KIMI_API_KEY: 'test-kimi', DEEPSEEK_API_KEY: 'test-deepseek', ARK_API_KEY: 'test-ark' };
const kimi = 'kimi/kimi-k2.7-code', fast = 'deepseek/deepseek-flash', strong = 'deepseek/deepseek-v4-pro';
const launch = (extra = {}, models = registry) => buildAppServerLaunch({ ...environment, ...extra }, '', { registry: models });
const workflow = step => ({ id: 'route-test', steps: [{ id: 'first', goal: '第一步', ...step }, { id: 'second', goal: '第二步' }] });

async function routingRig(t, { step, env = { AGENT_WEB_SEARCH: 'off' }, budget = {}, models = registry } = {}) {
  const r = await rig(t);
  r.config.launch = launch(env, models);
  if (step) r.config.agent.workflows = defineWorkflows({ skills: [], workflows: [workflow(step)] });
  r.sessions.usage.budget = budgetConfig({ AGENT_BUDGET_TIMEZONE: 'UTC', ...budget });
  const submit = (id, fields = {}) => r.messages.submit({ threadId: r.session.id, clientMessageId: id, text: id, ...fields });
  const started = async id => {
    await until(() => ['running', 'failed'].includes(r.messages.job(id)?.status));
    assert.equal(r.messages.job(id).status, 'running', r.messages.job(id).error);
    return r.rpc.calls.filter(call => call.method === 'turn/start').at(-1).params;
  };
  const finish = async id => { r.rpc.finish(r.session.id); await until(() => r.messages.job(id).status === 'completed'); };
  return { ...r, submit, started, finish };
}

function agentFixture(t) {
  const root = installToolFixture(tempRoot(t), { article: true });
  const file = path.join(root, 'agents/writing/agent.json');
  const definition = JSON.parse(fs.readFileSync(file));
  const configure = (step, env = { AGENT_WEB_SEARCH: 'off' }, models = registry) => {
    const copy = structuredClone(definition);
    const steps = copy.agent.workflows.find(w => w.id === 'write-article').steps;
    steps[0] = { id: 'outline', goal: '大纲', ...step };
    fs.writeFileSync(file, JSON.stringify(copy));
    const agent = new AgentDefinition(root);
    agent.configure({ launch: launch(env, models), memory: { enabled: false, use: false } }, { workspaceDir: path.join(root, 'workspace') });
    return agent;
  };
  return { root, configure };
}

test('路由策略：步骤 needs 校验、看图和长上下文挑选与逐候选错误', async t => {
  const { configure } = agentFixture(t);
  for (const needs of [{ image: 'true' }, { contextTokens: 0 }, { contextTokens: 1.5 }, { unknown: true }, { nativeTools: [] }])
    assert.throws(() => configure({ needs }), /Agent 定义无效/);
  const models = structuredClone(registry);
  models.models[fast].inputs = ['text'];
  models.models[kimi].inputs = ['text', 'image'];
  models.models[fast].contextWindow = 100;
  for (const needs of [{ image: true }, { contextTokens: 200_000 }]) {
    const agent = configure({ model: 'fast', needs }, { AGENT_WEB_SEARCH: 'off' }, models);
    assert.deepEqual(agent.workflows.resolve('write-article').steps[0].needs, needs);
    const r = await routingRig(t, { step: { model: 'fast', needs }, models });
    await r.submit('capable', { workflow: 'route-test' });
    const params = await r.started('capable');
    assert.equal(params.model, kimi);
  }
  assert.throws(() => configure({ model: fast, needs: { image: true } }, { AGENT_WEB_SEARCH: 'off' }, models), /不能看图/);
  assert.throws(() => configure({ model: 'fast', needs: { contextTokens: 9_000_000 } }), /deepseek.*上下文只有.*kimi.*上下文只有/);
  assert.equal(createModelRouter(models, environment).resolve({ model: 'fast', needs: { contextTokens: 200_000 } }).id, kimi);
});

test('路由策略：搜索约束覆盖场景、默认路由、具体模型和原生工具要求', () => {
  const router = launch().router;
  for (const model of ['fast', 'strong']) assert.equal(router.resolve({ model }).id, kimi);
  assert.throws(() => router.resolve({ model: fast }), /deepseek.*不支持原生能力 联网搜索/);
  const models = structuredClone(registry);
  models.scenes.noSearch = [fast, strong];
  assert.throws(() => launch({}, models).router.resolve({ model: 'noSearch' }), /deepseek-flash：.*web_search.*deepseek-v4-pro：.*web_search/);
  models.routes.chat = [fast, kimi];
  assert.equal(createModelRouter(models, environment, { webSearch: true }).resolve().id, kimi);
  assert.throws(() => router.resolve({ needs: { nativeTools: ['other_tool'] } }), /other_tool/);
  assert.equal(router.resolve({ purpose: 'image' }).purpose, 'image', '媒体不受搜索约束');
});

test('路由策略：写作 Agent 的 fast/strong 在 Kimi 搜索开启与 DeepSeek 关闭时均可配置', t => {
  const root = installToolFixture(tempRoot(t), { article: true });
  for (const [env, expected, ids] of [[{}, 'live', [kimi, kimi]], [{ CODEX_MODEL: fast }, 'disabled', [fast, strong]]]) {
    const config = { launch: launch(env), memory: { enabled: false, use: false } };
    const agent = new AgentDefinition(root);
    assert.doesNotThrow(() => agent.configure(config, { workspaceDir: path.join(root, 'workspace') }));
    const steps = agent.workflows.resolve('write-article').steps;
    assert.deepEqual(steps.map(step => step.model), ['fast', 'strong']);
    assert.equal(config.launch.webSearch, expected);
    assert.deepEqual(steps.map(step => config.launch.router.resolve(step).id), ids);
  }
});

test('路由策略：effort 启动校验、运行时再校验并传入 turn/start', async t => {
  const { configure } = agentFixture(t);
  configure({ model: 'fast', effort: 'high' });
  assert.throws(() => configure({ effort: 'invalid' }), /Agent 定义无效/);
  assert.throws(() => configure({ model: fast, effort: 'ultra' }), /不支持推理档位 ultra/);
  const models = structuredClone(registry); delete models.models[fast].reasoningLevels;
  assert.throws(() => configure({ model: fast, effort: 'high' }, { AGENT_WEB_SEARCH: 'off' }, models), /不支持调推理档位/);
  const r = await routingRig(t, { step: { model: 'fast', effort: 'high' } });
  await r.submit('effort', { workflow: 'route-test' });
  assert.equal((await r.started('effort')).effort, 'high');
  r.rpc.finish(r.session.id);
  await until(() => r.rpc.calls.filter(call => call.method === 'turn/start').length === 2);
  assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start')[1].params.effort, null, '未指定的下一步清除上步 effort');
  const invalid = await routingRig(t, { step: { effort: 'ultra' } });
  await invalid.submit('invalid', { workflow: 'route-test', model: fast });
  await until(() => invalid.messages.job('invalid').status === 'failed');
  assert.match(invalid.messages.job('invalid').error, /不支持推理档位/);
  assert.equal(invalid.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
});

// 使用真实 HTTP handler 和消息服务，不需要监听端口。
function request(service, url, body, token = 'unit-token') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  return new Promise(resolve => service.server.emit('request', req, {
    writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
    destroy() { resolve({ status: 500 }); },
  }));
}

test('路由策略：POST /messages 校验、存储、幂等、步骤优先级和 /state 选择来源', async t => {
  const r = await routingRig(t, { step: { model: 'fast' } });
  const http = createHttpService({ ...r, accounts: fixedAccounts() }); t.after(() => http.close());
  const body = { threadId: r.session.id, clientMessageId: 'task', text: '正文', model: 'strong' };
  for (const model of ['missing', 'missing/model', '', 1, [], null, 'ollama/qwen3-embedding:0.6b']) {
    const result = await request(http, '/messages', { ...body, model });
    assert.equal(result.status, 400); assert.ok(result.body.error.message);
  }
  const result = await request(http, '/messages', body);
  assert.equal(result.status, 202); assert.equal(result.body.model, 'strong');
  assert.equal((await r.started('task')).model, strong);
  const saved = (await request(http, `/state?threadId=${r.session.id}`)).body.queue.jobs[0];
  assert.equal(saved.selectedModel, strong); assert.equal(saved.modelSource, '任务指定：场景 strong');
  assert.equal((await request(http, '/messages', { ...body, model: 'fast' })).status, 409);
  assert.equal((await request(http, '/messages', body)).status, 202);
  await r.finish('task');
  await r.submit('step', { model: 'strong', workflow: 'route-test' });
  assert.equal((await r.started('step')).model, fast);
  assert.equal(r.messages.job('step').modelSource, '步骤指定：场景 fast');
  r.rpc.finish(r.session.id);
  await until(() => r.rpc.calls.filter(c => c.method === 'turn/start').length === 3);
  assert.equal(r.rpc.calls.at(-1).params.model, strong, '第二步没有 model，回到任务选择');
  await r.finish('step');
  await r.submit('default'); assert.equal((await r.started('default')).model, kimi);
  assert.equal(r.messages.job('default').modelSource, '默认路由');
  const searching = await routingRig(t, { env: {} });
  await assert.rejects(searching.submit('no-search', { model: fast }), error => error.status === 400 && /web_search/.test(error.message));
});

test('路由策略：GET /models 按用途返回能力、定价、场景、默认模型与搜索开关', async t => {
  const r = await routingRig(t, { env: {} });
  const http = createHttpService({ ...r, accounts: fixedAccounts() }); t.after(() => http.close());
  assert.equal((await request(http, '/models', undefined, 'wrong')).status, 401);
  const { status, body } = await request(http, '/models');
  assert.equal(status, 200); assert.equal(body.webSearch, 'live');
  assert.equal(body.defaults.chat, kimi); assert.equal(body.defaults.embedding, null);
  assert.equal(body.models.embedding.length, 0);
  assert.deepEqual(body.scenes.fast, registry.scenes.fast);
  const model = body.models.chat.find(model => model.id === kimi);
  assert.equal(model.image, false, '未实测标注 inputs 的模型不声明看图许可'); assert.ok(model.contextWindow > 0);
  assert.deepEqual(model.nativeTools, ['web_search']); assert.equal(typeof model.priced, 'boolean');
  assert.equal(body.models.image.length, 2); assert.equal(body.models.video.length, 2);
  assert.equal(body.models.image[0].priced, false);
  const priced = structuredClone(registry); priced.models[kimi].pricing = { input: 1, output: 2 };
  assert.equal(createModelRouter(priced, environment).catalog().models.chat.find(model => model.id === kimi).priced, true);
  assert.doesNotMatch(JSON.stringify(body), /test-kimi|test-ark|keyEnv|baseUrl/);
});

test('路由策略：备用链缺搜索、缺看图分别提醒，相同能力、未启用和非对话不提醒', () => {
  const warnings = fallbackWarnings(registry, environment);
  assert.ok(warnings.some(line => line.includes(`${kimi} 的备用 ${fast} 不支持联网搜索`)));
  const loss = structuredClone(registry); loss.models[kimi].inputs = ['text', 'image']; delete loss.models[fast].inputs;
  assert.ok(fallbackWarnings(loss, environment).some(line => line.includes(`${kimi} 的备用 ${fast} 不能看图`)));
  assert.deepEqual(fallbackWarnings(registry, { KIMI_API_KEY: 'test' }), []);
  const models = structuredClone(registry);
  for (const spec of Object.values(models.models)) delete spec.fallbacks;
  models.models[kimi].fallbacks = ['kimi/kimi-k2.6'];
  assert.deepEqual(fallbackWarnings(models, environment), []);
  assert.deepEqual(launch().warnings, warnings);
});

test('路由策略：看图备用告警只比较 inputs，逐条提醒且不改备用链', () => {
  const models = structuredClone(registry);
  for (const spec of Object.values(models.models)) delete spec.fallbacks;
  models.models[kimi].fallbacks = [fast, strong];
  models.models[kimi].inputs = ['text', 'image'];
  models.models[kimi].inputModalities = ['text'];
  for (const id of [fast, strong]) {
    models.models[id].inputModalities = ['text', 'image'];
    delete models.models[id].inputs;
  }
  models.models[strong].inputs = ['text'];
  const before = structuredClone(models);
  const imageWarnings = env => fallbackWarnings(models, env).filter(line => line.includes('不能看图'));
  assert.deepEqual(imageWarnings(environment), [fast, strong].map(id => `${kimi} 的备用 ${id} 不能看图，主模型出错切换过去时，带图片的请求会失败`));
  assert.deepEqual(models, before);
  assert.deepEqual(imageWarnings({ KIMI_API_KEY: 'test' }), []);
  for (const id of [fast, strong]) models.models[id].inputs = ['text', 'image'];
  assert.deepEqual(imageWarnings(environment), []);
  delete models.models[kimi].inputs;
  models.models[kimi].inputModalities = ['text', 'image'];
  for (const id of [fast, strong]) models.models[id].inputs = ['text'];
  assert.deepEqual(imageWarnings(environment), []);
  models.models[kimi].inputs = ['text', 'image']; models.models[kimi].purposes = ['image'];
  assert.deepEqual(imageWarnings(environment), []);
});

test('路由策略：预算比例校验、日月 token/金额触发、无上限不触发和周期恢复', async t => {
  const root = tempRoot(t); fs.cpSync(path.resolve(import.meta.dirname, '../config/models.json'), path.join(root, 'config/models.json'));
  for (const value of ['-0.1', '0', '1', '1.1', 'NaN', 'Infinity', 'abc'])
    assert.throws(() => loadServerConfig(root, { ...environment, AGENT_BUDGET_DOWNGRADE_AT: value }), /AGENT_BUDGET_DOWNGRADE_AT/);
  assert.throws(() => budgetConfig({ AGENT_BUDGET_DOWNGRADE_SCENE: fast }), /AGENT_BUDGET_DOWNGRADE_SCENE/);
  assert.throws(() => loadServerConfig(root, { ...environment, AGENT_BUDGET_DOWNGRADE_AT: '0.8', AGENT_BUDGET_DAILY_TOKENS: '100', AGENT_BUDGET_DOWNGRADE_SCENE: 'missing' }), /没有名为 missing/);
  for (const limit of ['DAILY_TOKENS', 'MONTHLY_TOKENS', 'DAILY_COST', 'MONTHLY_COST', null]) {
    const budget = budgetConfig({ AGENT_BUDGET_TIMEZONE: 'UTC', AGENT_BUDGET_DOWNGRADE_AT: '0.8', ...(limit ? { [`AGENT_BUDGET_${limit}`]: '100' } : {}) });
    let now = Date.parse('2026-11-30T12:00:00Z');
    const usage = new UsageService({ budget, now: () => now, registry: { models: { 'test/chat': { pricing: { input: 1_000_000, output: 0 } } } } });
    await usage.record({ source: 'chat', model: 'test/chat', inputTokens: 79 });
    assert.equal((await usage.budgetStatus()).downgraded, false);
    await usage.record({ source: 'chat', model: 'test/chat', inputTokens: 1 });
    const status = await usage.budgetStatus(); assert.equal(status.downgraded, Boolean(limit)); assert.equal(status.exceeded, false);
    now += 86400000;
    assert.equal((await usage.budgetStatus()).downgraded, false);
  }
});

test('路由策略：预算降级默认与步骤场景，具体模型豁免，保留能力约束和来源', async t => {
  for (const [step, selection, expected, source] of [
    [undefined, undefined, fast, '预算降级：场景 fast'],
    [{ model: 'strong' }, undefined, fast, '预算降级：场景 fast'],
    [undefined, 'strong', fast, '预算降级：场景 fast'],
    [undefined, strong, strong, `任务指定：${strong}`],
    [{ model: strong }, 'fast', strong, `步骤指定：${strong}`],
  ]) {
    const r = await routingRig(t, { step, budget: { AGENT_BUDGET_DAILY_TOKENS: '100', AGENT_BUDGET_DOWNGRADE_AT: '0.8' } });
    await r.sessions.usage.record({ source: 'chat', model: fast, inputTokens: 80 });
    await r.submit('budget', { ...(step ? { workflow: 'route-test' } : {}), ...(selection ? { model: selection } : {}) });
    assert.equal((await r.started('budget')).model, expected);
    assert.equal(r.messages.job('budget').modelSource, source);
    const http = createHttpService({ ...r, accounts: fixedAccounts() }); t.after(() => http.close());
    for (const url of ['/usage']) assert.equal((await request(http, url)).body.budget.downgraded, true);
  }
  for (const budget of [{}, { AGENT_BUDGET_DOWNGRADE_AT: '0.8' }, { AGENT_BUDGET_DAILY_TOKENS: '100', AGENT_BUDGET_DOWNGRADE_AT: '0.9' }]) {
    const r = await routingRig(t, { budget });
    await r.sessions.usage.record({ source: 'chat', model: fast, inputTokens: 80 });
    await r.submit('normal'); assert.equal((await r.started('normal')).model, kimi);
    assert.equal(r.messages.job('normal').modelSource, '默认路由');
  }
  const visionModels = structuredClone(registry); visionModels.models[kimi].inputs = ['text', 'image'];
  const r = await routingRig(t, { models: visionModels, env: {}, step: { needs: { image: true } }, budget: { AGENT_BUDGET_DAILY_TOKENS: '100', AGENT_BUDGET_DOWNGRADE_AT: '0.8' } });
  await r.sessions.usage.record({ source: 'chat', model: fast, inputTokens: 80 });
  await r.submit('search', { workflow: 'route-test' });
  assert.equal((await r.started('search')).model, kimi, '降级场景仍要求搜索和看图');
  const models = structuredClone(registry); models.models[fast].contextWindow = 100;
  const limited = await routingRig(t, { models, env: { CODEX_MODEL: strong }, step: { needs: { contextTokens: 500_000 } },
    budget: { AGENT_BUDGET_DAILY_TOKENS: '100', AGENT_BUDGET_DOWNGRADE_AT: '0.8' } });
  await limited.sessions.usage.record({ source: 'chat', model: fast, inputTokens: 80 });
  await limited.submit('limited', { workflow: 'route-test' });
  await until(() => limited.messages.job('limited').status === 'failed');
  assert.match(limited.messages.job('limited').error, /上下文只有/);
  assert.equal(limited.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('路由策略：混合用途场景验证与生图、生视频 quality 的请求模型', async t => {
  const copy = structuredClone(registry);
  copy.scenes.media = [...copy.routes.image, ...copy.routes.video];
  assert.doesNotThrow(() => validateRegistry(copy));
  assert.throws(() => createModelRouter(copy, environment).resolve({ model: 'media' }), /场景 media 里没有能做对话的模型/);
  copy.scenes.media = []; assert.throws(() => validateRegistry(copy), /非空/);
  copy.scenes.media = ['missing/model']; assert.throws(() => validateRegistry(copy), /清单里的模型/);
  const requests = [];
  const r = mediaRig(t, { fetchImpl: async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(url.endsWith('/videos') ? { id: `video-${requests.length}` } : { data: [{ b64_json: png.toString('base64') }] }));
  } });
  r.service.router = createModelRouter(registry, environment);
  for (const purpose of ['image', 'video']) for (const quality of [undefined, 'fast', 'strong']) {
    const method = purpose === 'image' ? 'generateImage' : 'generateVideo';
    const result = await r.call(method, { prompt: '测试', ...(quality ? { quality } : {}) });
    const expected = registry.routes[purpose][quality === 'strong' ? 1 : 0];
    assert.equal(result.model, expected); assert.equal(requests.at(-1).model, expected);
    assert.equal(requests.at(-1).quality, undefined, 'quality 只参与路由，不传给供应商');
  }
  for (const method of ['generateImage', 'generateVideo']) await assert.rejects(r.call(method, { prompt: '测试', quality: 'invalid' }), /quality/);
});

test('路由策略：客户端 /model 列表、选择、default、会话隔离和执行来源显示', async () => {
  const output = [], submissions = [], rl = new EventEmitter();
  let next = 0, listener;
  const terminal = { rl, write: text => output.push(text), endStream() {}, prompt() {}, close() { rl.emit('close'); } };
  const api = {
    async request(url, body) {
      if (url === '/models') return launch().router.catalog();
      if (url === '/sessions') return { id: `thread-${++next}`, turns: [] };
      if (url === '/messages') {
        submissions.push(body);
        const event = { type: 'queue', threadId: body.threadId, data: { jobs: [{ id: body.clientMessageId, status: 'starting', selectedModel: kimi, modelSource: '任务指定：场景 strong' }] } };
        listener(event); listener(event);
        return { status: 'queued' };
      }
      throw new Error(url);
    },
    subscribe(id, callback) { listener = callback; return { close() {}, done: Promise.resolve() }; },
  };
  const done = runChat(api, terminal);
  for (const line of ['/help', '/model', '/model invalid', '/model constructor', '/model strong', '第一条', `/model ${fast}`, '第二条', '/model default', '第三条', '/model fast', '/new', '新会话', '/exit']) rl.emit('line', line);
  await done;
  assert.deepEqual(submissions.map(body => body.model), ['strong', fast, undefined, undefined]);
  assert.match(output.join('\n'), /场景 strong：/); assert.match(output.join('\n'), /没有可用的对话模型或场景：invalid/);
  assert.equal(output.filter(text => text === `模型：${kimi}（任务指定：场景 strong）`).length, 4, '重复队列通知不重复显示');
});

test('路由策略：在途追加沿用当前模型，追加到已结束轮次使用任务选择', async t => {
  const r = await routingRig(t);
  await r.submit('original', { model: 'strong' }); await r.started('original');
  const targetTurnId = r.messages.job('original').turnId;
  await r.submit('append', { mode: 'append', targetTurnId, model: 'fast' });
  await until(() => r.messages.job('append').status === 'running');
  assert.equal(r.messages.job('append').selectedModel, strong);
  assert.equal(r.messages.job('append').modelSource, '沿用当前轮次');
  assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  await r.finish('original');
  await r.submit('followup', { mode: 'append', targetTurnId, model: 'fast' });
  assert.equal((await r.started('followup')).model, fast);
  assert.equal(r.messages.job('followup').modelSource, '任务指定：场景 fast');
});

test('路由策略：gateway:check 展示每个模型已启用的备用链', async t => {
  const { main, checkGateway } = await import('../scripts/gateway-check.mjs');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }));
  const report = await checkGateway({ environment, registry });
  assert.deepEqual(report.rows.find(row => row.model === kimi).fallbacks, [fast]);
  assert.deepEqual(report.rows.find(row => row.model === 'kimi/kimi-k2.6').fallbacks, []);
  const disabled = await checkGateway({ environment: { ...environment, DEEPSEEK_API_KEY: '' }, registry, model: kimi });
  assert.deepEqual(disabled.rows[0].fallbacks, []);
  const output = [];
  assert.equal(await main(['--model', kimi], { environment, registry, log: line => output.push(line) }), 0);
  assert.match(output.join('\n'), /备用链/);
  assert.ok(output.some(line => line.startsWith(`| ${kimi} | ${fast} |`)));
});
