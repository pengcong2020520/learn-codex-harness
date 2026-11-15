import test from 'node:test';
import assert from 'node:assert/strict';
import { compareResources, createReview, localBase, validatePlan } from '../scripts/walkthrough/model.mjs';
import { reviewHtml } from '../scripts/walkthrough.mjs';

export function samplePlan() {
  return { schemaVersion: 1, projectId: 'demo', mode: 'product', round: 1, previousRound: null, prd: 'prd-v1.md', source: { artifact: 'build.json', version: 1 },
    confirmation: { status: 'confirmed', confirmedAt: '2026-01-01T00:00:00Z', confirmedBy: '自动验收' },
    groups: [{ id: 'flow', title: '整理', order: 1, screens: [{ id: 'items', title: '事项', position: 1, states: ['default'], reproduce: { default: ['打开事项页'] },
      capture: { default: { steps: [{ open: '/app/' }], ready: '#items' } } }] }] };
}
test('采集前核对确认、产品与复现步骤，并限制在本机产品', () => {
  const plan = samplePlan();
  validatePlan(plan);
  assert.throws(() => localBase('https://example.com'));
  for (const change of [p => delete p.projectId, p => p.confirmation.status = 'proposed', p => p.groups[0].screens[0].capture.default.steps[0].open = '//example.com/', p => p.round = 2]) {
    const invalid = structuredClone(plan); change(invalid); assert.throws(() => validatePlan(invalid));
  }
});
test('回归保留多轮原话、分组及未匹配历史，只有同一资源的实际变化可以作为证据', () => {
  const plan = samplePlan(), first = createReview(plan, null, 'plan-v1.json'), g = first.groups[0], st = g.screens[0].states[0];
  st.feedback = { text: '原话\n第二行', mark: '待改', updatedAt: first.createdAt };
  g.feedback.text = '整条流程'; st.resources = { css: 'old' };
  const second = { ...plan, round: 2, previousRound: 1, source: { artifact: 'build.json', version: 2 } };
  validatePlan(second, first);
  const next = createReview(second, first, 'plan-v2.json'), state = next.groups[0].screens[0].states[0];
  assert.equal(state.previousFeedback[0].text, st.feedback.text);
  assert.equal(next.groups[0].previousFeedback[0].text, '整条流程');
  assert.equal(state.feedback.mark, null);
  state.screenshot = 'data:image/png;base64,AA=='; state.resources = { css: 'new' }; compareResources(state, 2);
  assert.equal(state.changeStatus, 'modified'); assert.deepEqual(state.changeEvidence.files, [{ file: 'css', before: 'old', after: 'new' }]);
  second.groups[0].screens[0].id = 'renamed';
  assert.equal(createReview(second, first, 'v2.json').unmatchedPrevious[0].previousFeedback[0].mark, '待改');
});
test('离线走查页将原话作为文本，保留替换字符且不加载外部资源', () => {
  const record = createReview(samplePlan(), null, 'v1.json');
  record.conclusion.text = '</script><aside>$&</aside>';
  const html = reviewHtml(record);
  const raw = html.match(/<script type="application\/json" id="record">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(raw).conclusion.text, record.conclusion.text);
  assert.doesNotMatch(html, /<script src=|<link href=|innerHTML\s*=/);
});
