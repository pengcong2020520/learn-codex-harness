import { fixedAccounts } from './accounts-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UsageService, periodBounds } from '../server/modules/usage/index.mjs';
import { budgetConfig, pricingWarning } from '../server/modules/usage/config.mjs';
import { validateRegistry, buildGatewayConfig } from '../server/modules/gateway/index.mjs';
import { Embeddings } from '../server/modules/knowledge/rag.mjs';
import { createHttpService } from '../server/modules/http/index.mjs';
import { runChat, formatUsage } from '../client/modules/chat/index.mjs';
import { loadServerConfig } from '../server/modules/config/index.mjs';
import { rig, until, tempRoot, fixture } from './helpers.mjs';

const registry = () => ({ schemaVersion: 1, providers: { example: { type: 'openai', keyEnv: 'EXAMPLE_API_KEY' } },
  models: { 'example/chat': { purposes: ['chat'], contextWindow: 1000, pricing: { input: 2, cachedInput: 1, output: 4 } } }, routes: { chat: ['example/chat'] } });
const fixed = Date.parse('2026-11-03T12:00:00Z');
const ledger = options => new UsageService({ registry: registry(), budget: budgetConfig({ AGENT_BUDGET_TIMEZONE: 'UTC' }), now: () => fixed, ...options });
const tokens = (total, input = 100, output = 20) => ({ total: { totalTokens: total }, last: {
  inputTokens: input, cachedInputTokens: 40, outputTokens: output, reasoningOutputTokens: 5, totalTokens: input + output } });

test('清单 currency / pricing：默认值、零价、有限非负数字和带模型字段的中文错误', () => {
  assert.equal(validateRegistry(registry()).currency, undefined);
  for (const currency of ['CNY', 'USD']) assert.equal(validateRegistry({ ...registry(), currency }).currency, currency);
  for (const currency of ['EUR', null, 1]) assert.throws(() => validateRegistry({ ...registry(), currency }), /currency.*CNY.*USD/);
  for (const pricing of [{ input: 0, output: 0 }, { input: 2, cachedInput: 0, output: 3 }]) {
    const r = registry(); r.models['example/chat'].pricing = pricing; validateRegistry(r);
  }
  for (const field of ['input', 'cachedInput', 'output']) for (const invalid of [-1, NaN, Infinity, '1', null]) {
    const r = registry(); r.models['example/chat'].pricing[field] = invalid;
    assert.throws(() => validateRegistry(r), new RegExp(`example/chat.*pricing.${field}.*非负数字`));
  }
  for (const invalid of [null, [], 'price', {}]) {
    const r = registry(); r.models['example/chat'].pricing = invalid;
    assert.throws(() => validateRegistry(r), /example\/chat.*pricing/);
  }
});

test('预算环境变量启动校验、缺省不限、未定价默认模型的一行提醒', t => {
  const root = tempRoot(t);
  for (const key of ['AGENT_BUDGET_DAILY_TOKENS', 'AGENT_BUDGET_MONTHLY_TOKENS', 'AGENT_GATEWAY_DAILY_TOKENS'])
    for (const value of ['-1', '1.1', 'Infinity', 'x', '9007199254740992'])
      assert.throws(() => loadServerConfig(root, { ...fixture, [key]: value }), new RegExp(key));
  for (const key of ['AGENT_BUDGET_DAILY_COST', 'AGENT_BUDGET_MONTHLY_COST'])
    for (const value of ['-1', 'NaN', 'Infinity', 'x']) assert.throws(() => budgetConfig({ [key]: value }), new RegExp(key));
  for (const timezone of ['invalid/timezone', '+08:00']) assert.throws(() => budgetConfig({ AGENT_BUDGET_TIMEZONE: timezone }), /IANA/);
  const budget = budgetConfig({ AGENT_BUDGET_DAILY_COST: '1.25', AGENT_BUDGET_MONTHLY_TOKENS: '0' });
  assert.equal(budget.dailyCost, 1.25); assert.equal(budget.monthlyTokens, 0);
  assert.equal(budgetConfig().dailyTokens, null);
  assert.equal(budgetConfig().timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.match(pricingWarning(registry(), 'example/missing', budget), /没定价的模型用量不计入金额/);
  assert.equal(pricingWarning(registry(), 'example/chat', budget), null);
  assert.equal(pricingWarning(null, null, budgetConfig()), null);
});

test('网关每日 token 兜底：1.5 倍向上取整、显式覆盖和虚拟密钥引用', () => {
  const env = { EXAMPLE_API_KEY: 'test-key' };
  const plain = buildGatewayConfig(registry(), env).governance;
  assert.equal(plain.rate_limits, undefined);
  assert.equal(plain.virtual_keys[0].rate_limit_id, undefined);
  for (const [values, expected] of [[{ AGENT_BUDGET_DAILY_TOKENS: '3' }, 5], [{ AGENT_BUDGET_DAILY_TOKENS: '3', AGENT_GATEWAY_DAILY_TOKENS: '2' }, 2], [{ AGENT_GATEWAY_DAILY_TOKENS: '7' }, 7]]) {
    const governance = buildGatewayConfig(registry(), { ...env, ...values }).governance;
    assert.deepEqual(governance.rate_limits, [{ id: 'codex-harness-daily', token_max_limit: expected, token_reset_duration: '1d', calendar_aligned: true }]);
    assert.equal(governance.virtual_keys[0].rate_limit_id, governance.rate_limits[0].id);
    assert.equal(governance.budgets, undefined);
  }
});

test('对话累计只用于去重，每次记 last；重启第一条不补记历史；成本不重复加缓存与推理', async () => {
  const usage = ledger(), context = { model: 'example/chat', taskId: 'job-1' };
  const event = total => ({ threadId: 'thread-1', turnId: 'turn-1', tokenUsage: tokens(total) });
  await usage.recordChat(event(1000), context);
  await usage.recordChat(event(1120), context);
  await usage.recordChat(event(1120), context);
  await usage.recordChat(event(1000), context);
  const result = await usage.summary();
  assert.equal(result.storage, 'memory');
  assert.equal(result.total.requests, 2); assert.equal(result.total.totalTokens, 240);
  assert.equal(result.total.estimatedCost, 0.00048);
  assert.equal(usage.rows[0].taskId, 'job-1');
  const restarted = ledger(); await restarted.recordChat(event(50000), context);
  assert.equal((await restarted.summary()).total.totalTokens, 120);
  const r = registry(); delete r.models['example/chat'].pricing.cachedInput;
  const normalCache = ledger({ registry: r }); await normalCache.recordChat(event(1), context);
  assert.equal((await normalCache.summary()).total.estimatedCost, 0.00028);
});

test('真实通知处理：RPC 响应之前记账并绑定任务；多个请求和重复通知不重复入账', async t => {
  const r = await rig(t);
  r.config.launch.model = 'example/chat';
  const request = r.rpc.request.bind(r.rpc);
  r.rpc.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'turn/start') for (const total of [1000, 1120, 1120]) r.rpc.notify('thread/tokenUsage/updated', {
      threadId: params.threadId, turnId: result.turn.id, tokenUsage: tokens(total),
    });
    return result;
  };
  await r.submit('工作', 'task-usage');
  await until(() => r.messages.job('task-usage').status === 'running');
  const usage = r.sessions.usage; await usage.pending;
  assert.equal(usage.rows.length, 2);
  assert.ok(usage.rows.every(row => row.model === 'example/chat' && row.taskId === 'task-usage' && row.turnId === 'turn-1'));
});

test('向量响应 usage 记账：prompt_tokens 优先，缺失时用 total_tokens，缺 usage 不猜测', async t => {
  const usage = ledger(); let resultUsage;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }], usage: resultUsage })));
  const embeddings = new Embeddings({ url: 'https://embedding.example/v1', model: 'example/embedding', dimensions: 2 }, usage);
  resultUsage = { prompt_tokens: 12, total_tokens: 12 }; assert.deepEqual(await embeddings.generate(['文本'], { threadId: 't', turnId: 'turn', taskId: 'task' }), [[1, 2]]);
  assert.equal(usage.rows[0].taskId, 'task');
  resultUsage = { total_tokens: 8 }; await embeddings.generate(['文本']);
  resultUsage = undefined; await embeddings.generate(['文本']);
  const summary = await usage.summary();
  assert.equal(summary.total.totalTokens, 20); assert.equal(summary.total.requests, 2);
  assert.equal(summary.bySource[0].source, 'embedding'); assert.equal(summary.total.unpricedRequests, 2);
});

test('时区自然日和自然月：跨 UTC 月份、夏令时 23/25 小时与半小时时差', () => {
  const bounds = (period, date, tz) => Object.fromEntries(Object.entries(periodBounds(period, Date.parse(date), tz)).map(([k, v]) => [k, new Date(v).toISOString()]));
  assert.deepEqual(bounds('today', '2026-11-01T06:00:00Z', 'America/Los_Angeles'), { start: '2026-10-31T07:00:00.000Z', end: '2026-11-01T07:00:00.000Z' });
  assert.deepEqual(bounds('month', '2026-11-01T06:00:00Z', 'America/Los_Angeles'), { start: '2026-10-01T07:00:00.000Z', end: '2026-11-01T07:00:00.000Z' });
  for (const [date, hours] of [['2026-03-08T12:00:00Z', 23], ['2026-11-01T12:00:00Z', 25]]) {
    const { start, end } = periodBounds('today', Date.parse(date), 'America/Los_Angeles'); assert.equal(end - start, hours * 3600000);
  }
  assert.equal(bounds('today', '2026-11-03T12:00:00Z', 'Asia/Kolkata').start, '2026-11-02T18:30:00.000Z');
});

test('日/月 token 和金额上限独立生效，所有来源计入；未计价模型不计金额', async () => {
  for (const [name, reason] of [['DAILY_TOKENS', /今日 token/], ['MONTHLY_TOKENS', /本月 token/], ['DAILY_COST', /今日 金额/], ['MONTHLY_COST', /本月 金额/]]) {
    const usage = ledger({ budget: budgetConfig({ AGENT_BUDGET_TIMEZONE: 'UTC', [`AGENT_BUDGET_${name}`]: name.endsWith('TOKENS') ? '100' : '0.0002' }) });
    await usage.record({ source: 'chat', model: 'example/chat', inputTokens: 100 });
    const status = await usage.budgetStatus(); assert.equal(status.exceeded, true); assert.match(status.reason, reason);
  }
  const usage = ledger({ budget: budgetConfig({ AGENT_BUDGET_TIMEZONE: 'UTC', AGENT_BUDGET_DAILY_TOKENS: '120', AGENT_BUDGET_DAILY_COST: '1' }) });
  await usage.record({ source: 'embedding', model: 'example/unpriced', inputTokens: 100 });
  await usage.record({ source: 'image', model: 'example/image', units: 2, inputTokens: 20 });
  await usage.record({ source: 'video', model: 'example/video', units: 3 });
  const result = await usage.summary();
  assert.equal(result.budget.exceeded, true); assert.match(result.budget.reason, /今日 token 已用 120/);
  assert.equal(result.total.estimatedCost, 0); assert.equal(result.total.unpricedRequests, 3);
  assert.equal(result.bySource.find(row => row.source === 'image').units, 2);
});

test('汇总边界排除昨天与上月，同一天到达多重上限时按最晚恢复时间等待', async () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const usage = ledger({ now: () => now, budget: budgetConfig({ AGENT_BUDGET_TIMEZONE: 'Asia/Shanghai', AGENT_BUDGET_DAILY_TOKENS: '100', AGENT_BUDGET_MONTHLY_TOKENS: '100' }) });
  await usage.record({ source: 'chat', model: 'example/chat', inputTokens: 999, createdAt: Date.parse('2026-10-31T15:59:59Z') });
  await usage.record({ source: 'chat', model: 'example/chat', inputTokens: 100, createdAt: Date.parse('2026-10-31T16:00:00Z') });
  const result = await usage.summary('month');
  assert.equal(result.total.totalTokens, 100); assert.equal(result.byDay[0].day, '2026-11-01');
  assert.equal(result.budget.resetsAt, '2026-11-30T16:00:00.000Z');
});

test('预算阻止 dispatch，保持 queued；轮次可完成、steer 不拦；到自然日自动恢复', async t => {
  const r = await rig(t), usage = r.sessions.usage;
  let now = Date.parse('2026-11-03T23:59:59.990Z');
  usage.now = () => now; usage.budget = budgetConfig({ AGENT_BUDGET_TIMEZONE: 'UTC', AGENT_BUDGET_DAILY_TOKENS: '100' });
  await r.submit('先执行', 'a'); await until(() => r.messages.job('a').status === 'running');
  await usage.record({ source: 'embedding', model: 'example/embed', inputTokens: 100 });
  await r.submit('排队', 'b');
  await r.submit('补充', 'append', 'append', r.messages.job('a').turnId);
  await until(() => r.messages.job('append').status === 'running');
  assert.equal(r.rpc.calls.filter(c => c.method === 'turn/steer').length, 1);
  r.rpc.finish(r.session.id);
  await until(() => r.messages.budgetTimers.has(r.session.id));
  const snapshot = await r.messages.snapshot(r.session.id);
  assert.equal(snapshot.budget.exceeded, true); assert.equal(r.messages.job('b').status, 'queued');
  assert.ok(r.hub.history.some(event => event.type === 'queue' && event.data.budget.exceeded));
  assert.equal(r.messages.job('a').status, 'completed');
  assert.equal(r.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
  now += 10;
  await until(() => r.messages.job('b').status === 'running');
  assert.equal((await r.messages.snapshot(r.session.id)).budget.exceeded, false);
});

// 直接向 Node HTTP server 投递 request 事件，验证真实路由，无需监听端口。
async function request(service, url, authorization = 'Bearer unit-token') {
  return new Promise(resolve => service.server.emit('request', { method: 'GET', url, headers: { authorization } }, {
    writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); }, destroy() { resolve({ status: 500 }); },
  }));
}
test('GET /usage 默认今日、本月结构、预算、鉴权与非法 period；/health 只报存活，/state 带预算', async t => {
  const r = await rig(t), usage = r.sessions.usage;
  await usage.record({ source: 'chat', model: 'example/chat', inputTokens: 5 });
  const http = createHttpService({ ...r, accounts: fixedAccounts(), usage }); t.after(() => http.close());
  for (const url of ['/usage', '/usage?period=month']) {
    const result = await request(http, url); assert.equal(result.status, 200);
    for (const key of ['total', 'byModel', 'bySource', 'byDay', 'budget', 'currency', 'timezone', 'storage']) assert.ok(key in result.body, key);
    assert.equal(result.body.total.totalTokens, 5);
  }
  assert.equal((await request(http, '/usage?period=year')).status, 400);
  assert.equal((await request(http, '/usage', 'Bearer wrong')).status, 401);
  assert.equal((await request(http, '/health')).body.status, 'alive');
  assert.equal((await request(http, `/state?threadId=${r.session.id}`)).body.queue.budget.exceeded, false);
});

test('客户端 /usage 与 /usage month 中文表格、未知价格、帮助和非法参数', async () => {
  const usage = ledger(); await usage.record({ source: 'image', model: 'example/image', units: 2 });
  const output = [], calls = [], rl = new EventEmitter();
  const terminal = { rl, write: text => output.push(text), endStream() {}, prompt() {}, close() { rl.emit('close'); } };
  const api = { async request(url) { calls.push(url); return usage.summary(url.endsWith('month') ? 'month' : 'today'); } };
  const done = runChat(api, terminal);
  for (const line of ['/usage', '/usage month', '/usage bad', '/help', '/exit']) rl.emit('line', line);
  await done;
  assert.deepEqual(calls, ['/usage?period=today', '/usage?period=month']);
  const text = output.join('\n');
  for (const pattern of [/今日用量/, /本月用量/, /缓存输入/, /推理输出/, /估算花费 CNY/, /example\/image/, /生图/, /1 条未计价/, /内存账本/, /用法：\/usage/, /\/usage \[month\]/]) assert.match(text, pattern);
  assert.match(formatUsage({ ...await usage.summary(), budget: { exceeded: true, reason: '今日 token 已用 10，上限 10', resetsAt: '2026-11-04T00:00:00Z' } }), /预算已达上限/);
});

test('数据库写入排队，预算等待落库；失败不允许继续按空账本派发', async () => {
  const pending = Promise.withResolvers(); const calls = [];
  const usage = ledger({ pool: { async query(sql, values) { calls.push({ sql, values }); if (sql.startsWith('INSERT')) await pending.promise; return { rows: [] }; } }, scope: { instanceId: 'instance', ownerId: 'owner' } });
  const write = usage.record({ source: 'image', model: 'example/image', units: 2 });
  const budget = usage.budgetStatus(); await Promise.resolve();
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].values.slice(0, 2), ['instance', 'owner']);
  pending.resolve(); await write; await budget;
  assert.equal(calls.length, 2); assert.match(calls[1].sql, /instance_id=\$1 AND owner_id=\$2/);
  const broken = ledger({ pool: { async query() { throw new Error('账本写入失败'); } }, scope: {} });
  await assert.rejects(broken.record({ source: 'chat', model: 'example/chat' }), /写入失败/);
  await assert.rejects(broken.budgetStatus(), /写入失败/);
});


test('月额度在下月恢复；补价格不改历史估算，切币种不混加旧币种金额', async () => {
  let now = Date.parse('2026-11-30T23:59:59Z');
  const usage = ledger({ now: () => now, budget: budgetConfig({ AGENT_BUDGET_TIMEZONE: 'UTC', AGENT_BUDGET_MONTHLY_TOKENS: '100' }) });
  await usage.record({ source: 'chat', model: 'example/chat', inputTokens: 100 });
  await usage.record({ source: 'embedding', model: 'example/new', inputTokens: 100 });
  usage.registry.models['example/new'] = { pricing: { input: 100, output: 100 } };
  let result = await usage.summary('month');
  assert.equal(result.total.estimatedCost, 0.0002); assert.equal(result.total.unpricedRequests, 1);
  assert.equal(result.budget.exceeded, true); assert.equal(result.budget.resetsAt, '2026-12-01T00:00:00.000Z');
  usage.currency = 'USD';
  result = await usage.summary();
  assert.equal(result.total.totalTokens, 200); assert.equal(result.total.estimatedCost, 0); assert.equal(result.total.unpricedRequests, 2);
  now += 1000;
  assert.equal((await usage.budgetStatus()).exceeded, false);
});
