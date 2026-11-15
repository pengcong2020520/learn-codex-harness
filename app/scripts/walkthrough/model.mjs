import path from 'node:path';

const id = /^[a-z][a-z0-9-]{0,47}$/;
const identifier = value => typeof value === 'string' && id.test(value);
const text = value => typeof value === 'string' && Boolean(value.trim());
const positive = n => Number.isSafeInteger(n) && n > 0;
const list = items => Array.isArray(items) && items.length > 0;
function requireValue(value, reason) { if (!value) throw Error(reason); }
function unique(items, key, reason) { requireValue(new Set(items.map(key)).size === items.length, reason); }
export function localBase(value) {
  const url = new URL(value);
  requireValue(['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]', 'caddy'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, '请提供本机产品入口，容器内使用 http://caddy。');
  return url.origin;
}
export function validatePlan(plan, previous) {
  requireValue(plan?.schemaVersion === 1 && plan.mode === 'product' && identifier(plan.projectId) && positive(plan.round) && text(plan.prd) && text(plan.source?.artifact) && positive(plan.source.version), '请填写真实产品、PRD、构建版本和轮次。');
  requireValue(plan.confirmation?.status === 'confirmed' && text(plan.confirmation.confirmedBy) && Number.isFinite(Date.parse(plan.confirmation.confirmedAt)), '巡查计划需要先确认，请记录确认人和时间。');
  requireValue(plan.round === 1 ? plan.previousRound === null && !previous :
    previous?.schemaVersion === 1 && previous.mode === 'product' && previous.projectId === plan.projectId && previous.round === plan.round - 1 && plan.previousRound === previous.round && list(previous.groups), '请提供同一产品上一轮导出的反馈 JSON，并核对 previousRound。');
  requireValue(list(plan.groups), '巡查计划缺少流程分组。');
  unique(plan.groups, g => g.id, '流程分组 id 重复。');
  for (const group of plan.groups) {
    requireValue(identifier(group.id) && text(group.title) && positive(group.order) && list(group.screens), '流程分组缺少名称、顺序或页面。');
    unique(group.screens, s => s.id, '同组页面 id 重复。');
    for (const screen of group.screens) {
      requireValue(identifier(screen.id) && text(screen.title) && positive(screen.position) && list(screen.states), '页面缺少名称、顺序或状态。');
      unique(screen.states, s => s, '同一页面状态重复。');
      for (const state of screen.states) {
        requireValue(typeof state === 'string' && id.test(state) && list(screen.reproduce?.[state]) && screen.reproduce[state].every(text), '每个状态须有稳定 id 和给人看的复现步骤。');
        const capture = screen.capture?.[state];
        if (text(capture?.unavailableReason)) continue;
        requireValue(list(capture?.steps) && capture.steps[0].open && text(capture.ready), '每个状态须有起始路径、操作和用于确认目标画面的 ready 选择器，或无法复现的原因。');
        for (const step of capture.steps) {
          const keys = Object.keys(step);
          requireValue(keys.length === 1 && ['open', 'click', 'fill', 'wait'].includes(keys[0]), '只支持 open、click、fill、wait 操作。');
          if (step.fill) {
            requireValue(text(step.fill.selector) && (typeof step.fill.value === 'string') !== Boolean(step.fill.fromEnv) && (!step.fill.fromEnv || /^WALKTHROUGH_INPUT_[A-Z0-9_]+$/.test(step.fill.fromEnv)), '输入步骤须提供选择器，以及测试文字或 WALKTHROUGH_INPUT_ 环境变量。');
          } else requireValue(text(step[keys[0]]), '路径或选择器为空。');
          if (step.open) requireValue(step.open.startsWith('/') && new URL(step.open, 'http://product.invalid').origin === 'http://product.invalid', '只能打开产品内相对路径。');
        }
      }
    }
  }
}

const blank = () => ({ text: '', mark: null, updatedAt: null });
const keyOf = (...ids) => JSON.stringify(ids);
export function createReview(plan, previous, filename) {
  const history = new Map();
  function collect(ids, entry) {
    const feedback = [...(entry.previousFeedback || [])];
    if (entry.feedback?.text || entry.feedback?.mark) feedback.push({ round: previous.round, ...entry.feedback });
    history.set(keyOf(...ids), { ids, feedback, old: entry });
  }
  for (const g of previous?.groups || []) {
    collect([g.id], g);
    for (const s of g.screens) for (const st of s.states) collect([g.id, s.id, st.state], st);
  }
  function take(...ids) { const key = keyOf(...ids), found = history.get(key); history.delete(key); return found; }
  const groups = [...plan.groups].sort((a,b) => a.order - b.order).map(g => ({
    id: g.id, title: g.title, order: g.order, feedback: blank(), previousFeedback: take(g.id)?.feedback || [],
    screens: [...g.screens].sort((a,b) => a.position - b.position).map(s => ({
      id: s.id, title: s.title, position: s.position, actions: s.actions || [],
      states: s.states.map(state => {
        const found = take(g.id, s.id, state);
        return { state, exclusion: null, reproduce: s.reproduce[state], screenshot: null, diagnostics: [], unavailableReason: null, changeStatus: found ? 'unknown' : 'new', changeEvidence: null,
          feedback: blank(), previousFeedback: found?.feedback || [], resources: {}, previousResources: found?.old.resources || {} };
      }),
    })),
  }));
  const unmatchedPrevious = [...(previous?.unmatchedPrevious || [])];
  for (const { ids: [groupId, screenId, state], feedback } of history.values()) {
    if (feedback.length) unmatchedPrevious.push({ groupId, screenId, state, previousFeedback: feedback });
  }
  const now = new Date().toISOString();
  return { schemaVersion: 1, projectId: plan.projectId, mode: 'product', round: plan.round, source: plan.source, previousRound: plan.previousRound, plan: path.basename(filename),
    createdAt: now, savedAt: now, saveVersion: 1, reviewer: null, status: 'in-progress', groups, unmatchedPrevious, conclusion: { text: '', confirmedBy: null, confirmedAt: null } };
}

export function compareResources(state, version) {
  const old = state.previousResources;
  delete state.previousResources;
  if (state.changeStatus === 'new' || !state.screenshot) return;
  const changed = Object.entries(state.resources).filter(([name, hash]) => old[name] && hash !== old[name]).map(([file, after]) => ({ file, before: old[file], after }));
  if (changed.length) { state.changeStatus = 'modified'; state.changeEvidence = { version, files: changed }; }
}
