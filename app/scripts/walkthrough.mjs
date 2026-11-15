import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './walkthrough/capture.mjs';
import { createReview, localBase, validatePlan } from './walkthrough/model.mjs';

export function reviewHtml(record) {
  const template = fs.readFileSync(new URL('./walkthrough/review.html', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('./walkthrough/review.js', import.meta.url), 'utf8');
  // 替换函数保留用户文字里的 $ 与换行；JSON 内的标签不参与 HTML 解析。
  return template.replace('REVIEW_CLIENT', () => client).replace('REVIEW_DATA', () => JSON.stringify(record).replaceAll('<', '\\u003c'));
}
export async function walkthrough({ planFile, previousFile, baseUrl, env = process.env }) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const previous = previousFile ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : null;
  validatePlan(plan, previous);
  const origin = localBase(baseUrl);
  const directory = path.dirname(fs.realpathSync(planFile)), target = path.join(directory, 'r' + plan.round);
  if (fs.existsSync(target)) throw Error('本轮已采集。请核对已有结果，下一轮使用新计划。');
  const lock = target + '.lock';
  try { fs.mkdirSync(lock); } catch { throw Error('本轮正在采集或上次意外中断。请先核对进程与轮次目录。'); }
  const staging = fs.mkdtempSync(path.join(directory, '.capture-'));
  try {
    const record = createReview(plan, previous, planFile);
    await capture(plan, record, staging, origin, env);
    const baseline = 'walkthrough-r' + plan.round + '.json';
    fs.writeFileSync(path.join(staging, baseline), JSON.stringify(record, null, 2) + '\n');
    fs.writeFileSync(path.join(staging, 'index.html'), reviewHtml(record));
    fs.renameSync(staging, target);
    return { target, record };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const [planFile, previousFile, ...extra] = process.argv.slice(2);
    if (!planFile || extra.length) throw Error('用法：walkthrough.mjs <已确认的计划.json> [上一轮的反馈.json]');
    const { target, record } = await walkthrough({ planFile, previousFile, baseUrl: process.env.WALKTHROUGH_BASE_URL || 'http://127.0.0.1:4317' });
    const states = record.groups.flatMap(group => group.screens.flatMap(screen => screen.states));
    const missing = states.filter(state => !state.screenshot).length;
    console.log('巡查已采集 ' + (states.length - missing) + '/' + states.length + ' 屏，走查页：' + path.join(target, 'index.html'));
    if (missing) { console.error('有 ' + missing + ' 个状态未复现，请在走查页核对原因。'); process.exitCode = 2; }
  } catch (error) { console.error('巡查未完成：' + error.message); process.exitCode = 1; }
}
