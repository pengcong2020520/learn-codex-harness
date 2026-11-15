import * as validators from './vendor/validators.mjs';

export const stages = ['资料卡', 'PRD', '低保真', '主题', '高保真', '代码与落地'];
export const steps = ['clarify', 'prd', 'lofi', 'theme', 'hifi', 'package'];
export const stateNames = { default: '默认', 'first-use': '首次使用', permission: '权限', loading: '加载中', empty: '无数据', error: '失败', recovery: '恢复' };
export const executing = new Set(['queued', 'starting', 'running', 'steering', 'dispatching', 'submitted']);
export const fieldGroups = [
  ['产品定位', [['name', 'Agent 名称', '例：售后客服助手', true], ['positioning', '一句话定位', '例：帮电商客服回答售后问题', true], ['platforms', '做哪一端（Web / 手机网页 / 两者）', '例：Web', true]]],
  ['用户与任务', [['audience', '目标用户', '例：电商店铺的客服人员', true], ['scenarios', '使用场景', '例：查询订单物流'], ['coreTasks', '核心任务（可多条）', '例：物流查询、退换货', true], ['deliverables', '交付物形式', '例：处理建议、工单']]],
  ['资料与能力', [['sources', '资料来源（上传 / 知识库 / 联网）', '例：商品手册、售后知识库'], ['confirmationPoints', '需要人确认的环节', '例：退款前人工确认'], ['modelRequirements', '对模型的要求（看图 / 联网 / 成本）', '例：需要看图，使用现有模型']]],
  ['范围', [['requiredPagesAndFeatures', '必须有的页面或功能', '例：对话、工单、知识库'], ['outOfScope', '明确不做的事', '例：不自动退款'], ['references', '参考产品或参考图（可上传）', '例：参考已有客服工作台']]],
  ['标准与约束', [['successCriteria', '成功标准', '例：客服能独立完成一次退货处理'], ['permissionsAndPrivacy', '权限与隐私要求', '例：仅本人能查看客户信息']]],
];
export function productId(name, now = Date.now()) {
  // 无拼音库时使用契约允许的时间后备，不截取中文名称中的零散英文字母。
  const id = /^[\x00-\x7f]+$/.test(name) ? name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') : '';
  return /^[a-z][a-z0-9-]{0,47}$/.test(id) ? id : `agent-${Math.trunc(now)}`;
}
export function feedbackLabel(mode, trigger = '') {
  if (mode === 'revise') {
    const round = trigger.match(/^提交第 (\d+) 轮澄清答案/);
    if (round) return `已提交第 ${round[1]} 轮答案`;
    if (trigger === '换一换：风格') return '正在换一组风格';
    if (trigger === '换一换：主题') return '正在换一组主题';
    if (trigger === '按结构改动决定生成') return '正在按你的决定生成';
  }
  const labels = { steer: '已加入当前生成', revise: '正在按你的意见重做', queued: '意见已排队，将在当前步骤执行' };
  if (!labels[mode]) throw Error('意见结果待核对，请刷新任务记录，不要重复发送。');
  return labels[mode];
}
export function latest(files, family, extension, marker = 'v') {
  const pattern = new RegExp(`^${family}-${marker}([1-9][0-9]*)\\.${extension}$`);
  return files.filter(file => pattern.test(file)).sort((a, b) => Number(a.match(pattern)[1]) - Number(b.match(pattern)[1])).at(-1);
}
export function validateArtifact(kind, value, project) {
  const validate = validators[kind.replaceAll('-', '_')];
  if (!validate || !validate(value)) throw Error(`${kind} 产物不符合工作室契约，请在聊天中反馈并重新生成。`);
  if (project && value.projectId !== project) throw Error('产物项目不匹配，请核对当前项目。');
  const unique = (items, label) => { if (new Set(items).size !== items.length) throw Error(`${label} 重复，请重新生成。`); };
  if (kind === 'clarify') {
    unique(value.questions.map(q => q.id), '问题标识');
    for (const q of value.questions) unique(q.options.map(o => o.label), '选项');
  }
  if (kind === 'structure-changes') unique(value.items.map(item => item.id), '结构提案标识');
  if (kind === 'themes') {
    unique([...value.styles, ...value.themes].map(item => item.id), '候选标识');
    unique(value.shownHistory.map(item => item.id), '历史候选标识');
    if (JSON.stringify([...value.shown].sort()) !== JSON.stringify(value.shownHistory.map(item => item.id).sort())) throw Error('主题历史与已展示候选不一致。');
  }
  return value;
}
export function themeHash(style, theme) {
  if (!validators.style_tokens(style) || !validators.theme_tokens(theme)) throw Error('主题令牌无效，请重新选择。');
  const bytes = new TextEncoder().encode(JSON.stringify({ style, theme }));
  return `theme=${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}
const list = text => String(text || '').split(/[、\n]/).map(s => s.trim()).filter(Boolean);
export function briefDraft(values, id, attachments = []) {
  const fields = {};
  for (const key of ['name', 'positioning', 'coreTasks', 'deliverables', 'sources', 'confirmationPoints', 'platforms', 'requiredPagesAndFeatures', 'outOfScope', 'references', 'successCriteria', 'modelRequirements', 'permissionsAndPrivacy']) {
    const text = values[key] || '';
    const value = ['name', 'positioning', 'modelRequirements', 'permissionsAndPrivacy'].includes(key) ? text : list(text);
    fields[key] = { value, source: 'user', evidence: text };
  }
  fields.audienceAndScenarios = { value: [values.audience, values.scenarios].filter(Boolean), source: 'user', evidence: [values.audience, values.scenarios].filter(Boolean).join('；') };
  fields.references.value.push(...attachments);
  return { schemaVersion: 1, projectId: id, clarificationRounds: 0, fields };
}
export function restoreBrief(draft) {
  const values = {};
  for (const [key, field] of Object.entries(draft?.fields || {})) values[key] = Array.isArray(field.value) ? field.value.join('、') : typeof field.value === 'object' ? JSON.stringify(field.value) : field.value;
  [values.audience, values.scenarios] = draft?.fields?.audienceAndScenarios?.value || [];
  values.references = (draft?.fields?.references?.value || []).filter(value => !value.startsWith('inputs/uploads/')).join('、');
  return values;
}
export function createDraftSaver(write) {
  let pending = Promise.resolve(), blocked = false, value;
  return { get blocked() { return blocked; }, get value() { return value; }, stage(next) { value = structuredClone(next); },
    save(next) {
      value = structuredClone(next);
      const snapshot = structuredClone(next), manualRetry = blocked;
      const result = pending.then(() => {
        if (blocked && !manualRetry) throw Error('上一份草稿保存失败，待用户核对后手动重试。');
        return write(snapshot);
      });
      pending = result.catch(() => {});
      return result.then(output => { blocked = false; return output; }, error => { blocked = true; throw error; });
    }
  };
}
export function projectPath(project, relative) {
  if (!validators.project(project) || typeof relative !== 'string' || relative.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f?#%:]/.test(relative) || relative.startsWith('/')) throw Error('产物路径无效，请核对项目。');
  return `outputs/design/${project.id}/${relative}`;
}

export function packageGroups(files) {
  const groups = new Map();
  for (const { path } of files) {
    const group = path.startsWith('design/') ? 'design/' : path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(path.slice(group.length));
  }
  return [...groups].map(([directory, files]) => ({ directory, files }));
}
export function historyGroups(entries, currentStep) {
  const definitions = [
    ['资料卡与澄清', /^(brief-v|clarify-r)/], ['PRD', /^prd-v/], ['低保真', /^wireframe-v/],
    ['主题', /^(themes-r|theme-v|theme-sample-v)/], ['高保真', /^(prototype-v|structure-changes-v)/], ['代码与落地', /^package-v/],
  ];
  return definitions.map(([title, pattern], step) => {
    const files = entries.filter(entry => pattern.test(entry.name)).sort((a, b) =>
      new Date(b.updatedAt) - new Date(a.updatedAt) || Number(b.name.match(/(?:v|r)(\d+)/)?.[1]) - Number(a.name.match(/(?:v|r)(\d+)/)?.[1]));
    return { title, step, versions: files.map((entry, index) => {
      const number = entry.name.match(/([vr])(\d+)/), time = new Date(entry.updatedAt);
      const label = number?.[1] === 'r' ? `第 ${number[2]} 轮` : `v${number?.[2] || 1}`;
      return { ...entry, label, time: Number.isNaN(time.getTime()) ? '时间未知' : time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), confirmed: step < currentStep && index === 0 };
    }) };
  }).filter(group => group.versions.length).reverse();
}
