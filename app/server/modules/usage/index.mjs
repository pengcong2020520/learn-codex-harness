import { AppError } from '../../../shared/errors.mjs';
import { budgetConfig } from './config.mjs';

const formatters = new Map();
export function dayKey(time, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const parts = formatters.get(timezone).formatToParts(time);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// 找当地日期第一次出现的时刻；不能用固定 24 小时相加（夏令时也可能在午夜切换）。
function startOfDate(date, timezone) {
  const nominal = Date.parse(`${date}T00:00:00Z`);
  let low = nominal - 36 * 3600000, high = nominal + 36 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (dayKey(mid, timezone) < date) low = mid;
    else high = mid;
  }
  return high;
}
export function periodBounds(period, now, timezone) {
  const today = dayKey(now, timezone), [year, month, day] = today.split('-').map(Number);
  const startDate = period === 'month' ? `${today.slice(0, 7)}-01` : today;
  const next = new Date(Date.UTC(year, period === 'month' ? month : month - 1, period === 'month' ? 1 : day + 1)).toISOString().slice(0, 10);
  return { start: startOfDate(startDate, timezone), end: startOfDate(next, timezone) };
}

const metrics = ['requests', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'unpricedRequests'];
const empty = () => ({ requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
  units: null, estimatedCost: 0, unpricedRequests: 0 });
function add(target, row) {
  for (const key of metrics) target[key] += Number(row[key]);
  if (row.units !== null) target.units = (target.units || 0) + Number(row.units);
  target.estimatedCost += Number(row.estimatedCost);
}

export class UsageService {
  constructor({ pool, scope, registry = null, budget = budgetConfig(), now = Date.now } = {}) {
    Object.assign(this, { pool, scope, registry, budget, now });
    this.storage = pool ? 'postgres' : 'memory';
    this.currency = registry?.currency || 'CNY';
    this.rows = [];
    this.pending = Promise.resolve();
    this.threadTotals = new Map();
  }
  record({ source, model, threadId = null, turnId = null, taskId = null, inputTokens = 0, cachedInputTokens = 0,
    outputTokens = 0, reasoningOutputTokens = 0, totalTokens = inputTokens + outputTokens, units = null, createdAt = this.now() }) {
    if (!['chat', 'embedding', 'image', 'video'].includes(source) || typeof model !== 'string' || !model.includes('/')) throw new Error('用量来源或模型无效：模型必须写成“服务商/模型名”。');
    for (const value of [inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('用量 token 必须是非负安全整数。');
    if (cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens || (units !== null && (!Number.isFinite(units) || units < 0))) throw new Error('用量的缓存、推理 token 或 units 无效。');
    const pricing = this.registry?.models?.[model]?.pricing;
    const cost = pricing ? ((inputTokens - cachedInputTokens) * pricing.input + cachedInputTokens * (pricing.cachedInput ?? pricing.input) + outputTokens * pricing.output) / 1e6 : null;
    const row = { source, model, threadId, turnId, taskId, createdAt, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, units,
      currency: this.currency, estimatedCost: cost, requests: 1, unpricedRequests: cost === null ? 1 : 0 };
    // 失败保持在链上，后续预算读取也失败，不能带着不完整账本继续派发。
    this.pending = this.pending.then(async () => {
      if (!this.pool) { this.rows.push(row); return; }
      await this.pool.query(`INSERT INTO agent_data.usage(instance_id,owner_id,created_at,thread_id,turn_id,task_id,source,model,
        input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,units,currency,estimated_cost)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [this.scope.instanceId, this.scope.ownerId, new Date(createdAt), threadId, turnId, taskId, source, model,
        inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, units, this.currency, cost]);
    });
    return this.pending;
  }
  recordChat({ threadId, turnId, tokenUsage }, context) {
    const total = tokenUsage.total.totalTokens;
    if (this.threadTotals.has(threadId) && total <= this.threadTotals.get(threadId)) return this.pending;
    this.threadTotals.set(threadId, total);
    return this.record({ ...context, ...tokenUsage.last, threadId, turnId, source: 'chat' });
  }
  async grouped(start, end) {
    await this.pending;
    if (!this.pool) return this.rows.filter(row => row.createdAt >= start && row.createdAt < end)
      .map(row => ({ ...row, day: dayKey(row.createdAt, this.budget.timezone), estimatedCost: row.estimatedCost || 0 }));
    return (await this.pool.query(`SELECT model,source,currency,to_char(created_at AT TIME ZONE $5,'YYYY-MM-DD') AS day,
      count(*)::float8 AS requests, sum(input_tokens)::float8 AS "inputTokens", sum(cached_input_tokens)::float8 AS "cachedInputTokens",
      sum(output_tokens)::float8 AS "outputTokens",sum(reasoning_output_tokens)::float8 AS "reasoningOutputTokens",
      sum(total_tokens)::float8 AS "totalTokens",sum(units) AS units,coalesce(sum(estimated_cost),0) AS "estimatedCost",
      count(*) FILTER(WHERE estimated_cost IS NULL)::float8 AS "unpricedRequests"
      FROM agent_data.usage WHERE instance_id=$1 AND owner_id=$2 AND created_at >= $3 AND created_at < $4
      GROUP BY model,source,currency,day ORDER BY day,model,source`,
    [this.scope.instanceId, this.scope.ownerId, new Date(start), new Date(end), this.budget.timezone])).rows;
  }
  totals(rows) {
    const total = empty();
    for (const row of rows) {
      // 改币种后不混加历史货币；token 仍全部计入，旧币种金额明确标为未计价。
      add(total, row.currency === this.currency ? row : { ...row, estimatedCost: 0, unpricedRequests: row.requests });
    }
    return total;
  }
  status(rows, now) {
    const today = dayKey(now, this.budget.timezone);
    const daily = this.totals(rows.filter(row => row.day === today)), monthly = this.totals(rows);
    const violations = [];
    for (const [period, label, total, tokenLimit, costLimit] of [
      ['today', '今日', daily, this.budget.dailyTokens, this.budget.dailyCost],
      ['month', '本月', monthly, this.budget.monthlyTokens, this.budget.monthlyCost],
    ]) {
      for (const [used, limit, unit] of [[total.totalTokens, tokenLimit, 'token'], [total.estimatedCost, costLimit, `金额（${this.currency}）`]])
        if (limit !== null && used >= limit) violations.push({ reason: `${label} ${unit} 已用 ${used}，上限 ${limit}`, reset: periodBounds(period, now, this.budget.timezone).end });
    }
    return { exceeded: violations.length > 0, reason: violations.map(item => item.reason).join('；') || null,
      resetsAt: violations.length ? new Date(Math.max(...violations.map(item => item.reset))).toISOString() : null,
      timezone: this.budget.timezone, currency: this.currency, limits: this.budget, daily, monthly };
  }
  async budgetStatus() {
    const now = this.now(), bounds = periodBounds('month', now, this.budget.timezone);
    return this.status(await this.grouped(bounds.start, now + 1), now);
  }
  async summary(period = 'today') {
    if (!['today', 'month'].includes(period)) throw new AppError('period 只能是 today 或 month。', 400);
    const now = this.now(), month = periodBounds('month', now, this.budget.timezone), bounds = periodBounds(period, now, this.budget.timezone);
    const monthly = await this.grouped(month.start, now + 1);
    const rows = period === 'month' ? monthly : monthly.filter(row => row.day === dayKey(now, this.budget.timezone));
    const group = key => [...new Set(rows.map(row => row[key]))].sort().map(value => ({ [key]: value, ...this.totals(rows.filter(row => row[key] === value)) }));
    return { period, timezone: this.budget.timezone, currency: this.currency, storage: this.storage,
      start: new Date(bounds.start).toISOString(), end: new Date(bounds.end).toISOString(),
      total: this.totals(rows), byModel: group('model'), bySource: group('source'), byDay: group('day'), budget: this.status(monthly, now) };
  }
}
