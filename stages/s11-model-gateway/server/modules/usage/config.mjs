// 空值表示不限；0 表示不允许继续消耗。token 必须能用安全整数表示。
export function limitValue(environment, name, integer = false) {
  const raw = environment[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
    throw new Error(`${name} 必须是非负${integer ? '安全整数（token 数）' : '数字（金额）'}。`);
  return value;
}

export function budgetConfig(environment = {}) {
  const timezone = environment.AGENT_BUDGET_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    if (/^[+-]/.test(timezone)) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  }
  catch { throw new Error('AGENT_BUDGET_TIMEZONE 必须是有效的 IANA 时区名。'); }
  const dailyTokens = limitValue(environment, 'AGENT_BUDGET_DAILY_TOKENS', true);
  const monthlyTokens = limitValue(environment, 'AGENT_BUDGET_MONTHLY_TOKENS', true);
  const dailyCost = limitValue(environment, 'AGENT_BUDGET_DAILY_COST');
  const monthlyCost = limitValue(environment, 'AGENT_BUDGET_MONTHLY_COST');
  limitValue(environment, 'AGENT_GATEWAY_DAILY_TOKENS', true);
  const raw = environment.AGENT_BUDGET_DOWNGRADE_AT?.trim();
  const downgradeAt = raw === undefined || raw === "" ? null : Number(raw);
  if (downgradeAt !== null && (!/^0?\.\d+$/.test(raw) || !(downgradeAt > 0 && downgradeAt < 1)))
    throw new Error('AGENT_BUDGET_DOWNGRADE_AT 必须是大于 0、小于 1 的小数。');
  const downgradeScene = environment.AGENT_BUDGET_DOWNGRADE_SCENE?.trim() || 'fast';
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(downgradeScene)) throw new Error('AGENT_BUDGET_DOWNGRADE_SCENE 必须是合法场景名。');
  return { timezone, dailyTokens, monthlyTokens, dailyCost, monthlyCost, downgradeAt, downgradeScene };
}

export function pricingWarning(registry, model, budget) {
  return (budget.dailyCost !== null || budget.monthlyCost !== null) && !registry?.models?.[model]?.pricing
    ? `用量预算提醒：默认对话模型 ${model || '未知'} 没有 pricing；没定价的模型用量不计入金额。` : null;
}
