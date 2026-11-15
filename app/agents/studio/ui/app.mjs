import { createApi, apiError } from '/ui/modules/api.mjs';
import { emptyState, reduceEvent, statusLabel } from '/ui/modules/view-model.mjs';
import { uploadInfo } from '/ui/modules/uploads.mjs';
import { stages, steps, stateNames, executing, fieldGroups, productId, feedbackLabel, latest, validateArtifact, themeHash, briefDraft, restoreBrief, createDraftSaver, projectPath, packageGroups, historyGroups } from './model.mjs';
import { markdown, outlineFromHtml } from './markdown.mjs';

const $ = selector => document.querySelector(selector);
const el = (tag, className = '', text) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
const add = (node, ...children) => { node.append(...children.filter(Boolean)); return node; };
const button = (text, handler, className = '', disabled = false) => {
  const node = el('button', className, text); node.type = 'button'; node.disabled = disabled;
  node.addEventListener('click', () => Promise.resolve().then(handler).catch(showError)); return node;
};
const s = { bench: null, project: null, state: emptyState(), task: null, thread: null, files: [], entries: [], artifacts: {},
  welcome: true, brief: {}, briefAttachments: [], attachments: [], chatText: '', chat: [], context: null, contextRemoved: false,
  clarifyAnswers: {}, themeSelection: {}, structureDecisions: {}, history: null, historyOpen: false, handoff: false, handoffTab: 'PROMPT.md',
  askReference: false, busy: false, uploadCount: 0, leftCollapsed: false, rightCollapsed: false, saveError: '', uncertain: false,
  thinkingOpen: false, connection: '', subscription: null, artifactKey: '', autoContinued: new Set(), preview: null, outline: null, selection: null };
const tokenKey = 'agent.web.token';
function login() {
  s.subscription?.close(); sessionStorage.removeItem(tokenKey);
  location.replace(`/ui/?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
}
const api = createApi({ getToken: () => sessionStorage.getItem(tokenKey), onUnauthorized: login });
function showError(error) {
  s.error = error.message || '操作失败，请核对任务状态后再试。'; renderError();
}
function renderError() {
  document.querySelectorAll('.error-status').forEach(node => node.remove());
  if (!s.error) return;
  const row = add(el('div', 'error error-status'), el('span', '', s.error), button('×', () => { s.error = ''; renderError(); }, 'fold'));
  row.setAttribute('role', 'alert'); row.querySelector('button').setAttribute('aria-label', '关闭错误提示');
  const target = $('#dialog')?.open ? $('#dialog') : $('#messages') || $('#brief-form') || $('#clarify-form') || $('.center-message');
  target?.append(row);
}
async function action(work) {
  if (s.busy || s.uploadCount) return;
  s.busy = true; syncDisabled();
  try { return await work(); } finally { s.busy = false; syncDisabled(); }
}
function syncDisabled() {
  for (const node of document.querySelectorAll('#brief-form input:not([type=file]), #clarify-form input, #clarify-form textarea')) node.disabled = s.busy;
  for (const node of document.querySelectorAll('[data-action]')) node.disabled = s.busy || Boolean(s.uploadCount) || s.uncertain;
}
function actionButton(text, work, className = 'primary') {
  const node = button(text, () => action(work), className); node.dataset.action = ''; return node;
}
async function putDraft(name, value) {
  const response = await fetch(`/workspace/drafts?name=${encodeURIComponent(name)}`, { method: 'PUT', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${sessionStorage.getItem(tokenKey) || ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  if (!response.ok) { if (response.status === 401) login(); throw apiError(response.status, await response.json().catch(() => ({})), response.headers.get('Retry-After')); }
  return response.json();
}
async function workspaceEntries(path = '') {
  const result = await api.request(`/workspace?path=${encodeURIComponent(path)}`);
  if (result.truncated) throw Error('目录超过接口展示上限，请负责人核对完整目录。');
  return result.entries;
}
async function optionalDirectory(path) {
  let parent = '';
  for (const part of path.split('/')) {
    const entries = await workspaceEntries(parent);
    if (!entries.some(entry => entry.name === part && entry.type === 'directory')) return [];
    parent = parent ? `${parent}/${part}` : part;
  }
  return workspaceEntries(path);
}
async function draft(name, knownNames) {
  if (!knownNames.includes(name)) return null;
  return JSON.parse((await api.request(`/workspace/drafts?name=${name}`)).content);
}
async function listing(relative = '') {
  const result = await api.request(`/workspace?path=${encodeURIComponent(projectPath(s.project, relative || 'placeholder').replace(/\/placeholder$/, ''))}`);
  if (result.truncated) throw Error('产物目录超过接口展示上限，请负责人核对完整目录。');
  return result.entries;
}
async function read(relative) {
  const result = await api.request(`/workspace/read?path=${encodeURIComponent(projectPath(s.project, relative))}`);
  if (result.truncated) throw Error('产物正文超过读取上限，不能展示不完整内容，请负责人核对。');
  return result.content;
}
async function json(file, kind) {
  const value = validateArtifact(kind, JSON.parse(await read(file)), s.project.id);
  const numbered = file.match(/-(?:v|r)([1-9]\d*)\.json$/);
  if (numbered && (value.round ?? value.version) !== undefined && (value.round ?? value.version) !== Number(numbered[1])) throw Error('产物编号与内容版本不一致，请重新生成。');
  return value;
}
const briefSaver = createDraftSaver(value => putDraft('brief.json', value));
let saveTimer;
function currentBrief() {
  const id = s.project?.id || s.briefId || (s.briefId = productId(s.brief.name || ''));
  return briefDraft(s.brief, id, s.briefAttachments.map(item => item.path));
}
function stageBrief() {
  clearTimeout(saveTimer); briefSaver.stage(currentBrief());
  if (briefSaver.blocked) { updateSaveStatus(s.saveError); return; }
  saveTimer = setTimeout(() => saveBrief().catch(() => {}), 1000);
}
async function saveBrief() {
  clearTimeout(saveTimer);
  try { await briefSaver.save(currentBrief()); s.saveError = ''; updateSaveStatus('草稿已保存'); }
  catch (error) { s.saveError = `草稿保存失败：${error.message} 输入已保留，请稍后点击重试。`; updateSaveStatus(s.saveError); throw error; }
}
function updateSaveStatus(text) { if ($('#save-status')) $('#save-status').textContent = text; if ($('#retry-save')) $('#retry-save').hidden = !s.saveError; }

function uploadControl(target, documents = false, label = '上传图片') {
  const input = el('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
  input.accept = documents ? '.png,.jpg,.jpeg,.webp,.md,.txt' : '.png,.jpg,.jpeg,.webp';
  input.dataset.upload = target;
  input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; upload(files, target, documents).catch(showError); });
  const control = button(label, () => input.click(), 'upload-label', !documents && !s.bench.imageInput);
  return add(el('div'), control, input);
}
function uploadDrop(node, target, documents = false) {
  node.addEventListener('dragover', event => { event.preventDefault(); node.classList.add('dragging'); });
  node.addEventListener('dragleave', () => node.classList.remove('dragging'));
  node.addEventListener('drop', event => { event.preventDefault(); node.classList.remove('dragging'); upload(event.dataTransfer.files, target, documents).catch(showError); });
  node.addEventListener('paste', event => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); upload(files, target, documents).catch(showError); }
  });
}
async function upload(files, target, documents) {
  if (s.history || s.bench.workflowActivity?.find(item => item.workflow === 'design')?.occupant) throw Error('当前只读，不能上传附件。');
  const destination = target === 'brief' ? s.briefAttachments : s.attachments;
  s.uploadCount++; syncDisabled();
  try {
    for (const file of files) {
      if (destination.length >= 4) throw Error('每条消息最多 4 个附件，请先移除附件或发送。');
      const safeName = file.name.replace(/[^A-Za-z0-9\p{Script=Han}_.-]/gu, '-').replace(/^\.+/, '').slice(-60);
      const path = `inputs/uploads/${crypto.randomUUID()}-${safeName}`;
      const info = uploadInfo(path);
      if (!documents && !info.image) throw Error('对话区仅支持 png、jpeg 和 webp 图片。');
      if (info.image && !s.bench.imageInput) throw Error('当前模型不能看图，请在 config/models.json 配置能看图的模型。');
      if (file.size > info.limit) throw Error(info.image ? '图片不能超过 5 MiB。' : '文档不能超过 256 KiB。');
      // 原始文件交给现有上传接口核对文件头，不把客户端 MIME 当作真实性依据。
      await api.upload(path, file, info.contentType);
      destination.push({ path, name: file.name, image: info.image });
      renderAttachments(target);
      if (target === 'brief') stageBrief();
    }
  } catch (error) { throw Error(`上传未完成：${error.message} 已上传的附件仍保留；请核对后手动操作。`); }
  finally { s.uploadCount--; syncDisabled(); }
}
function renderAttachments(target) {
  const root = document.querySelector(`[data-attachments="${target}"]`); if (!root) return;
  const items = target === 'brief' ? s.briefAttachments : s.attachments;
  root.replaceChildren(...items.map((item, index) => add(el('span', 'attachment'), el('span', '', item.name), button('×', () => {
    items.splice(index, 1); renderAttachments(target); if (target === 'brief') stageBrief();
  }))));
}
function attachmentBox(target) { const node = el('div', 'attachments'); node.dataset.attachments = target; return node; }
function heading(title, subtitle) { return add(el('div', 'form-head'), el('h1', '', title), subtitle && el('p', 'muted', subtitle)); }
function centerMessage(title, text, control) { return add(el('div', 'center-message'), el('h1', '', title), text && el('p', 'muted', text), control); }
function setView(screen, state = 'default') { $('#main').dataset.screen = screen; $('#main').dataset.state = state; }
function render() {
  $('#studio').setAttribute('aria-busy', 'false');
  const main = $('#main'); main.replaceChildren();
  $('#history').hidden = !s.bench?.viewer.admin || !s.project;
  if (!s.bench?.viewer.admin) { setView('web-p9'); main.append(centerMessage('产品设计中', '这个产品还在设计，暂时不能使用。请联系管理员。')); return; }
  const occupant = s.bench.workflowActivity?.find(item => item.workflow === 'design')?.occupant;
  if (occupant) {
    setView('web-s3', 'readonly');
    main.append(centerMessage('他人正在设计 · 只读', `${occupant.username} · 开始于 ${new Date(occupant.startedAt).toLocaleString()}`, button('结束他人占用任务', () => takeover(occupant)))); renderError(); return;
  }
  if (s.welcome && !s.task) { renderWelcome(main); return; }
  const step = s.askReference ? 3 : s.task?.step ?? -1;
  main.append(renderLeft(step));
  const center = el('main', 'center'); center.id = 'center'; main.append(center);
  if (s.history) renderHistoryView(center);
  else if (!s.task) { setView('web-s1', s.briefAttachments.length ? 'attached' : 'default'); center.append(renderBrief()); }
  else if (s.askReference) { setView('web-s5', 'ask-reference'); center.append(centerMessage('选择参考图', '选好参考图或直接出选项后，这里显示套用效果。')); }
  else if (s.handoff) { setView('web-s8'); center.append(renderHandoff()); }
  else if (executing.has(s.task.status)) { setView(`web-s${Math.max(2, step + 2)}`, 'loading'); renderGenerating(center); }
  else if (['failed', 'interrupted', 'needs-review', 'unconfirmed', 'replica_missing'].includes(s.task.status)) {
    setView(`web-s${step + 2}`, 'error');
    if (!renderPrevious(center)) center.append(centerMessage('这一步未完成', failureReason(), s.task.status !== 'replica_missing' && step === 0 && actionButton('重新生成', retry)));
  } else if (s.task.status === 'cancelled') { setView(`web-s${step + 2}`, 'ended'); center.append(centerMessage('任务已结束', '已有版本已保留，可以在版本历史中查看。')); }
  else if (s.artifactError) { setView(`web-s${step + 2}`, 'error'); center.append(centerMessage('产物需要核对', s.artifactError, button('重新读取', () => refreshArtifacts(true)))); }
  else if (step === 0) { setView('web-s2', s.artifacts.clarify?.round === 2 ? 'round-2' : 'default'); center.append(renderClarify()); }
  else if (step === 1) { setView('web-s3'); renderDocument(center, s.artifacts.prd || '', true); }
  else if ([2, 3, 4].includes(step)) { setView(`web-s${step + 2}`, s.artifacts.structure?.items.length && step === 4 ? 'structure-review' : 'default'); renderPreview(center); }
  else { setView('web-s7', s.task.status === 'completed' ? 'complete' : 'loading'); center.append(renderPackage()); }
  if (step >= 1 || s.history) main.append(renderChat());
  renderDirectory();
  if (!s.history && executing.has(s.task?.status) && !$('#directory .generating-label')) $('#directory .dir-title')?.append(el('span', 'generating-label', '生成中'));
  renderAttachments('brief'); renderAttachments('chat'); syncDisabled();
  if (s.historyOpen) renderHistoryDrawer();
  renderError();
}
function renderWelcome(root) {
  setView('web-p1', 'first-use');
  const welcome = add(el('main', 'welcome'), el('h1', '', '开始设计你的 Agent'), el('p', 'muted', '6 个阶段，从想法到可以落地的代码。可以随时中断，下次回来接着做。'),
    el('p', 'muted', '生成代码之后，在你的电脑上由 Codex 或 Claude Code 完成落地、开发和巡查，你在走查页上逐屏反馈，修好再部署。'));
  welcome.append(add(el('ol', 'steps-six'), ...stages.map((name, index) => add(el('li'), el('i', '', index + 1), el('span', '', name)))));
  welcome.append(button('开始设计', () => { s.welcome = false; render(); }, 'primary'), el('p', 'muted', '只有管理员能进入工作室；一份脚手架对应一个产品。'));
  root.append(welcome);
}
function renderLeft(step) {
  const aside = el('aside', `left${s.leftCollapsed ? ' collapsed' : ''}`);
  const toggle = () => { s.leftCollapsed = !s.leftCollapsed; aside.classList.toggle('collapsed', s.leftCollapsed); };
  aside.append(add(el('div', 'rail'), button('>', toggle, 'fold')),
    add(el('div', 'panel-head'), el('strong', '', '阶段'), button('<', toggle, 'fold')),
    add(el('ol', 'stages'), ...stages.map((name, index) => add(el('li', `stage${index === Math.max(0, step) ? ' current' : index < step ? ' done' : ''}`), el('i', '', index < step ? '✓' : index + 1), el('span', '', name)))));
  const dir = el('nav', 'directory'); dir.id = 'directory'; dir.setAttribute('aria-label', '页面目录'); aside.append(dir); return aside;
}
function renderBrief() {
  const form = el('form', 'brief'); form.id = 'brief-form';
  form.append(heading('描述你的 Agent', '带 * 的 5 项必填，其余可以先空着，后面会用补充题帮你完善。'));
  for (const [index, [title, fields]] of fieldGroups.entries()) {
    const group = el('fieldset'); group.id = `brief-group-${index}`; group.append(el('legend', '', `${index + 1} ${title}`));
    const grid = el('div', 'field-grid');
    for (const [key, label, example, required] of fields) {
      const input = el('input'); input.name = key; input.id = `brief-${key}`; input.placeholder = example; input.required = Boolean(required); input.value = s.brief[key] || '';
      input.addEventListener('input', () => { s.brief[key] = input.value; updateSaveStatus(s.saveError || '尚未保存'); stageBrief(); });
      grid.append(add(el('label', 'field'), add(el('span'), el('span', '', label), required && el('em', 'required', '*')), input));
    }
    group.append(grid);
    if (index === 3) {
      const uploadArea = add(el('div', 'upload-area'), attachmentBox('brief'), uploadControl('brief', true, '＋ 添加参考图或文档（可多选，也可拖拽到这里）'));
      if (!s.bench.imageInput) uploadArea.append(el('small', '', '当前模型不能看图；可以上传文档，或在 config/models.json 配置能看图的模型。'));
      uploadDrop(uploadArea, 'brief', true); group.append(uploadArea);
    }
    form.append(group);
  }
  const submit = el('button', 'primary', '提交资料卡'); submit.type = 'submit'; submit.dataset.action = '';
  const saveStatus = el('span', 'muted', s.saveError || '停止输入 1 秒后保存'); saveStatus.id = 'save-status';
  const retry = button('重试保存', saveBrief); retry.id = 'retry-save'; retry.hidden = !s.saveError;
  form.append(add(el('div', 'form-footer'), submit, saveStatus, retry));
  form.addEventListener('submit', event => { event.preventDefault(); action(submitBrief).catch(showError); });
  return add(el('div', 'view'), form);
}
async function submitBrief() {
  await saveBrief();
  const name = s.brief.name.trim();
  s.project = { id: s.project?.id || productId(name), name };
  await putDraft('project.json', s.project);
  // 项目 id 在名称完整提交后确定，同步资料卡，避免自动保存期的临时 id 留在正式输入。
  await saveBrief();
  const session = await api.request('/sessions', {}); s.thread = session.id;
  const clientMessageId = crypto.randomUUID();
  try {
    await api.request('/messages', { threadId: s.thread, clientMessageId, workflow: 'design', text: '按资料卡开始设计；请读取 inputs/drafts/project.json 和 brief.json。', attachments: s.briefAttachments.map(item => item.path) });
  } catch (error) { s.uncertain = true; throw Error(`任务提交结果待核对：${error.message} 输入已保留，请刷新工作室核对，不要重复提交。`); }
  await connect(s.thread);
}
function renderClarify() {
  const data = s.artifacts.clarify;
  if (!data) return centerMessage('正在等待澄清产物', '生成结束后会显示补充题。');
  if (data.final) return centerMessage('资料已齐，开始写 PRD', '', s.autoContinueError && actionButton('核对后继续', () => confirm('资料已齐，开始写 PRD')));
  const form = el('form', 'clarify'); form.id = 'clarify-form';
  form.append(heading('再确认几个问题', `第 ${data.round} / 3 轮。选择推荐项或自由填写。`));
  for (const [index, q] of data.questions.entries()) {
    s.clarifyAnswers[q.id] ??= q.options.find(option => option.recommended).label;
    const question = el('fieldset', 'question'); question.append(el('legend', '', `${index + 1}. ${q.text}`));
    for (const option of q.options) {
      const input = el('input'); input.type = 'radio'; input.name = q.id; input.value = option.label; input.checked = s.clarifyAnswers[q.id] === option.label;
      input.addEventListener('change', () => { s.clarifyAnswers[q.id] = option.label; const free = form.querySelector(`[data-free="${q.id}"]`); if (free) free.value = ''; });
      question.append(add(el('label', 'option'), input, el('span', '', option.label), option.recommended && el('em', 'recommended', '推荐')));
    }
    const free = el('input'); free.placeholder = '或自由填写'; free.setAttribute('aria-label', `${q.text}：自由填写`); free.dataset.free = q.id;
    free.value = q.options.some(option => option.label === s.clarifyAnswers[q.id]) ? '' : s.clarifyAnswers[q.id] || '';
    free.addEventListener('input', () => { s.clarifyAnswers[q.id] = free.value; for (const radio of question.querySelectorAll('[type=radio]')) radio.checked = false; });
    question.append(free); form.append(question);
  }
  const supplement = el('textarea'); supplement.placeholder = '补充说明（可选）'; supplement.setAttribute('aria-label', '澄清补充说明'); supplement.value = s.clarifySupplement || '';
  supplement.addEventListener('input', () => { s.clarifySupplement = supplement.value; }); form.append(supplement);
  const submit = el('button', 'primary', '提交'); submit.type = 'submit'; submit.dataset.action = '';
  const finish = actionButton('信息已足够，直接生成 PRD', async () => {
    const answers = data.questions.map(q => ({ id: q.id, text: (s.clarifyAnswers[q.id] || '').trim() }));
    if (answers.some(answer => !answer.text)) throw Error('请先核对当前选项或填写答案。');
    await putDraft('clarify.json', { round: data.round, answers });
    await feedback(`提交第 ${data.round} 轮澄清答案\n信息已足够，请根据这些答案完成资料卡，停止补充提问。${s.clarifySupplement ? `\n${s.clarifySupplement}` : ''}`, [], false);
  }, 'chip');
  form.append(add(el('div', 'form-footer'), submit, finish));
  form.addEventListener('submit', event => { event.preventDefault(); action(async () => {
    const answers = data.questions.map(q => ({ id: q.id, text: (s.clarifyAnswers[q.id] || '').trim() }));
    if (answers.some(answer => !answer.text)) throw Error('请逐题选择或填写答案后提交。');
    await putDraft('clarify.json', { round: data.round, answers });
    await feedback(`提交第 ${data.round} 轮澄清答案${s.clarifySupplement ? `\n${s.clarifySupplement}` : ''}`, [], false);
  }).catch(showError); });
  return add(el('div', 'view'), form);
}
function renderDocument(center, text, headings = false) {
  const article = el('article', 'doc'); article.append(markdown(text));
  if (headings) [...article.querySelectorAll('h1,h2,h3')].forEach((node, index) => { node.id = `heading-${index}`; });
  center.append(add(el('div', 'view'), article));
}
function renderPrevious(center) {
  if (s.task.step === 1 && s.artifacts.prd) { renderDocument(center, s.artifacts.prd, true); return true; }
  if ([2, 3, 4].includes(s.task.step) && s.preview) { renderPreview(center); return true; }
  if (s.task.step === 5 && s.artifacts.manifest) { center.append(renderPackage()); return true; }
  return false;
}
function renderGenerating(center) {
  const progress = el('progress', 'progress'); progress.setAttribute('aria-label', '生成进度');
  if (renderPrevious(center)) { progress.classList.add('progress-inline'); center.prepend(progress); return; }
  const tools = Object.values(s.state.session?.turns?.at(-1)?.tools || {});
  const box = centerMessage(`正在生成${stages[s.task.step] || '补充题'}……`, tools.at(-1)?.label || '等待当前步骤完成');
  box.prepend(progress); center.append(box);
}
function failureReason() {
  if (s.task.status === 'needs-review') return (s.task.checks || []).filter(check => !check.passed).map(check => check.detail || check.message || check.id).join('；') || s.task.error || '检查未通过';
  return s.task.error || '结果待核对，请检查任务记录';
}
function renderPreview(center) {
  if (!s.preview) { center.append(centerMessage('预览尚未就绪', '等待产物生成或在聊天中提出修改意见。')); return; }
  const frame = el('iframe', 'preview'); frame.title = '设计产物预览'; frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.id = 'preview';
  center.append(frame); updatePreview();
}
function updatePreview() {
  const frame = $('#preview'); if (!frame || !s.preview) return;
  const params = new URLSearchParams();
  if (s.selection) { params.set('screen', s.selection.screen); params.set('state', s.selection.state); }
  if (s.task?.step === 3 && !s.history && s.artifacts.themes) {
    const data = s.artifacts.themes, style = s.themeSelection.style || data.styles[0], theme = s.themeSelection.theme || data.themes[0];
    params.set('theme', new URLSearchParams(themeHash(style.tokens, theme.tokens)).get('theme'));
  }
  frame.src = `${s.preview.url}#${params}`;
}
function renderDirectory() {
  const root = $('#directory'); if (!root) return; root.replaceChildren();
  const nav = (title, action, selected = false) => { const node = button(title, action, `dir-page${selected ? ' selected' : ''}`); if (selected) node.setAttribute('aria-current', 'page'); return node; };
  if (!s.task && !s.history) {
    root.append(el('div', 'dir-title', '资料卡'), ...fieldGroups.map(([name], index) => nav(`${index + 1} ${name}`, () => $(`#brief-group-${index}`).scrollIntoView({ block: 'start' })))); return;
  }
  if (s.handoff && !s.history) {
    root.append(el('div', 'dir-title', '落地'), ...[['PROMPT.md', '给本地编码助手的指令'], ['DEPLOY.md', '部署手册']].map(([file, label]) => nav(label, () => { s.handoffTab = file; render(); }, s.handoffTab === file))); return;
  }
  if (!s.history && (s.askReference || s.task?.step === 3)) {
    root.append(el('div', 'dir-title', '主题'));
    if (s.askReference || !s.artifacts.themes || !s.outline) { root.append(el('p', 'muted', '等待选项')); return; }
    const screens = s.outline.groups.flatMap(group => group.screens);
    const core = [...new Map(s.artifacts.themes.screens.map(item => [item.sourceScreenId, item])).keys()];
    for (const id of core) {
      const screen = screens.find(screen => screen.id === id); if (!screen) continue;
      const state = s.artifacts.themes.screens.find(item => item.sourceScreenId === id).state;
      root.append(nav(`样页 · ${screen.title}`, () => { s.selection = { screen: id, state }; s.context = { label: '主题' }; s.contextRemoved = false; updatePreview(); renderDirectory(); renderContext(); }, s.selection?.screen === id));
    }
    if (executing.has(s.task.status)) root.querySelector('.dir-title').append(el('span', 'generating-label', '生成中'));
    return;
  }
  const headings = [...document.querySelectorAll('.doc h1[id],.doc h2[id],.doc h3[id]')];
  if (headings.length) {
    root.append(el('div', 'dir-title', 'PRD 目录'), ...headings.map(node => nav(node.textContent, () => { node.scrollIntoView({ block: 'start' }); for (const sibling of root.querySelectorAll('button')) sibling.classList.remove('selected'); const index = headings.indexOf(node); root.querySelectorAll('button')[index]?.classList.add('selected'); s.context = { label: node.textContent.slice(0, 150) }; s.contextRemoved = false; renderContext(); }))); return;
  }
  if (s.outline && $('#preview')) {
    root.append(el('div', 'dir-title', s.task?.step === 3 ? '样页目录' : '原型目录'));
    for (const group of [...s.outline.groups].sort((a, b) => a.order - b.order)) {
      root.append(el('div', 'dir-group', group.title));
      for (const screen of [...group.screens].sort((a, b) => a.position - b.position)) {
        const select = state => { s.selection = { screen: screen.id, state }; s.context = { screen: screen.id, state, label: screen.title }; s.contextRemoved = false; updatePreview(); renderDirectory(); renderContext(); };
        root.append(nav(screen.title, () => select(screen.states[0]), s.selection?.screen === screen.id));
        const states = el('div', 'dir-states');
        for (const state of screen.states) states.append(button(stateNames[state] || state, () => select(state), `chip${s.selection?.screen === screen.id && s.selection?.state === state ? ' selected' : ''}`));
        root.append(states);
      }
    }
  } else { root.append(el('div', 'dir-title', s.task?.step === 0 ? '补充题' : stages[s.task?.step] || '版本历史'), el('p', 'muted', s.task?.step === 0 ? `第 ${s.artifacts.clarify?.round || 1} / 3 轮` : s.artifacts.packageDir || '等待生成')); }
}
function renderChat() {
  const aside = el('aside', `right${s.rightCollapsed ? ' collapsed' : ''}`); aside.id = 'chat';
  const toggle = () => { s.rightCollapsed = !s.rightCollapsed; aside.classList.toggle('collapsed', s.rightCollapsed); };
  aside.append(add(el('div', 'rail'), button('<', toggle, 'fold')));
  const menu = el('details', 'chat-menu'); menu.append(el('summary', '', '…'), button('结束并保存进度', () => endTask()));
  aside.append(add(el('div', 'panel-head'), el('strong', '', '对话'), menu, button('>', toggle, 'fold')));
  const connection = el('div', 'connection', s.connection); connection.id = 'connection'; connection.hidden = !s.connection; aside.append(connection);
  const messages = el('div', 'messages'); messages.id = 'messages'; aside.append(messages);
  const choices = el('div', 'theme-choices'); choices.id = 'theme-choices'; choices.hidden = true; aside.append(choices);
  if (s.task?.status === 'completed' && s.task.step === 5 && !s.history) {
    aside.append(el('p', 'muted completed-note', '设计已完成；之后的修改在你的电脑上由编码助手完成。'));
    queueMicrotask(renderMessages); return aside;
  }
  const composer = el('form', 'composer'); composer.id = 'composer';
  const context = el('div'); context.id = 'context'; composer.append(context, attachmentBox('chat'));
  const input = el('textarea'); input.id = 'chat-input'; input.rows = 2; input.maxLength = 2000; input.placeholder = '说说你的意见，或点击快捷回复'; input.setAttribute('aria-label', '聊天输入'); input.value = s.chatText;
  const readonly = Boolean(s.history || s.task?.status === 'cancelled' || s.task?.status === 'completed');
  input.disabled = readonly; input.addEventListener('input', () => { s.chatText = input.value; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } });
  const send = el('button', 'primary', '发送'); send.type = 'submit'; send.disabled = readonly;
  if (!readonly) send.dataset.action = '';
  composer.append(input, add(el('div', 'composer-bottom'), !readonly && uploadControl('chat'), send));
  if (!s.bench.imageInput && !readonly) composer.append(el('small', '', '参考图不可用：请在 config/models.json 配置能看图的模型。'));
  composer.addEventListener('submit', event => { event.preventDefault(); if (readonly) return; action(async () => {
    const text = s.chatText.trim() || (s.attachments.length ? '请结合参考图生成风格和主题。' : '');
    if (!text) throw Error('请填写意见或上传参考图。');
    if (s.askReference) await startTheme(text); else await feedback(text);
  }).catch(showError); });
  aside.append(composer); if (!readonly) uploadDrop(aside, 'chat');
  // 这里只更新消息容器，不重建输入框；流式事件不会丢失用户正在输入的意见。
  queueMicrotask(() => { renderMessages(); renderContext(); renderAttachments('chat'); });
  return aside;
}
function renderContext() {
  const node = $('#context'); if (!node) return; node.replaceChildren();
  if (s.contextRemoved || s.history || s.task?.step === 5 || s.handoff) return;
  const label = s.askReference || s.task?.step === 3 ? '主题' : s.context ? [s.context.label || s.context.screen, stateNames[s.context.state] || s.context.state].filter(Boolean).join(' / ') : stages[s.task?.step] || '';
  if (label) node.append(add(el('span', 'context'), el('span', '', `当前：${label}`), button('×', () => { s.contextRemoved = true; renderContext(); })));
}
function renderMessages() {
  const root = $('#messages'); if (!root) return;
  const bottom = root.scrollHeight - root.scrollTop - root.clientHeight < 40;
  const oldScroll = root.scrollTop;
  root.replaceChildren();
  const choices = $('#theme-choices'); if (choices) { choices.replaceChildren(); choices.hidden = true; }
  if (s.history) {
    root.append(el('p', '', `你正在查看 ${s.history.file}（只读）。`), button('回到当前版本', async () => { s.history = null; await refreshArtifacts(true); })); return;
  }
  // 工作流输入含内部长提示词；当前区保持一问一答，完整轮次仍由服务端保存。
  const question = s.chat.findLast(entry => entry.role === 'user')?.text || s.task?.note || s.task?.text;
  if (question) root.append(el('div', 'message user', question));
  const turn = s.state.session?.turns?.find(turn => turn.id === s.task?.turnId) || s.state.session?.turns?.at(-1);
  for (const answer of Object.values(turn?.answers || {})) {
    const message = el('div', 'message assistant'); message.append(markdown(answer)); root.append(message);
  }
  const receipt = s.chat.at(-1);
  if (receipt?.role === 'assistant') root.append(el('p', 'muted', receipt.text));
  if (s.task && executing.has(s.task.status)) {
    const thinking = el('details', 'thinking'); thinking.open = s.thinkingOpen;
    thinking.addEventListener('toggle', () => { if (thinking.isConnected) s.thinkingOpen = thinking.open; });
    const tools = Object.values(s.state.session?.turns?.at(-1)?.tools || {});
    thinking.append(el('summary', '', `思考中 · ${tools.at(-1)?.label || stages[s.task.step]}`), add(el('ol'), ...tools.map(tool => el('li', '', `${tool.label || tool.name} · ${statusLabel(tool.status)}`))));
    root.append(thinking);
  }
  if (s.askReference) {
    root.append(el('p', '', '线框已确认。要不要上传参考的风格或主题图片？一张或多张都可以，直接拖到对话区即可。'),
      add(el('div', 'quick'), button('上传参考图', () => document.querySelector('[data-upload="chat"]').click(), 'chip primary', !s.bench.imageInput), actionButton('不用，直接出选项', () => startTheme(), 'chip')));
  } else if (s.task?.status === 'waiting' && !s.artifactError) {
    if ((s.task.reviseCount || 0) >= 10) root.append(el('p', 'error', '本步已重做 10 次，请确认继续或结束任务。'));
    if (s.task.step === 3 && s.artifacts.themes && choices) { choices.hidden = false; renderThemeChoices(choices); }
    else if ([2, 4].includes(s.task.step) && s.artifacts.structure?.items.length) renderStructure(root);
    else if (s.task.step > 0) {
      const label = s.task.step === 4 ? '确认，生成代码' : '确认，进入下一步';
      root.append(add(el('div', 'quick'), actionButton(label, async () => {
        if (s.task.step === 2) { s.askReference = true; render(); } else await confirm(label);
      }, 'chip primary'), button('我有修改意见', () => $('#chat-input').focus(), 'chip', (s.task.reviseCount || 0) >= 10)));
    }
  } else if (s.task?.status === 'completed' && s.task.step === 5 && !s.handoff && s.artifacts.manifest) {
    root.append(el('p', '', '代码包已生成，请核对检查结果。'), actionButton('查看落地指令', () => { s.handoff = true; render(); }, 'chip primary'));
  }
  if (s.task && ['failed', 'interrupted', 'needs-review', 'unconfirmed', 'replica_missing'].includes(s.task.status)) {
    const previous = s.artifacts.prd ? '上一版文档' : s.preview ? '上一版预览' : s.artifacts.manifest ? '上一版代码包' : null;
    root.append(el('p', 'error generation-error', `这次生成失败：${failureReason().replace(/[。；]+$/, '')}。${previous ? `${previous}保持不变。` : '请核对后重新生成。'}`));
    if (s.task.status !== 'replica_missing') root.append(actionButton('重新生成', retry, 'chip primary'));
  }
  renderError();
  if (s.handoff) root.append(el('p', '', '复制指令交给本地编码助手。它会先完成落地、开发和本机运行，再带你巡查真实产品。'));
  if (choices && !choices.hidden) root.scrollTop = 0;
  else if (bottom) root.scrollTop = root.scrollHeight; else root.scrollTop = oldScroll;
  syncDisabled();
}
function renderThemeChoices(root) {
  const data = s.artifacts.themes;
  root.append(el('p', '', '两道题各选一项，样页预览会立刻切换。'));
  for (const [kind, title, items] of [['style', '视觉风格 · 三选一', data.styles], ['theme', '配色与字体 · 三选一', data.themes]]) {
    const card = add(el('div', 'choice'), el('strong', '', title));
    for (const [index, item] of items.entries()) {
      const selected = s.themeSelection[kind]?.id === item.id;
      const option = button('', () => {
        s.themeSelection[kind] = { ...item, round: s.artifacts.themeOrigins[item.id] };
        updatePreview(); renderMessages();
      }, `choice-option${selected ? ' selected' : ''}`);
      option.dataset.choice = item.id; option.setAttribute('aria-pressed', String(selected));
      option.append(el('span', '', `${selected ? '◉' : '○'} ${String.fromCharCode(65 + index)} ${item.name}`), el('small', '', item.traits.join(' · '))); card.append(option);
    }
    if (s.themeSelection[kind] && !items.some(item => item.id === s.themeSelection[kind].id)) card.append(el('p', 'muted', `已保留第 ${s.themeSelection[kind].round} 轮选择：${s.themeSelection[kind].name}`));
    card.append(actionButton('换一换', async () => { await feedback(`换一换：${kind === 'style' ? '风格' : '主题'}`, [], false); }, 'chip'));
    card.dataset.kind = kind; root.append(card);
  }
  if (s.themeSelection.style && s.themeSelection.theme) root.append(actionButton('确认，生成高保真', async () => {
    const style = s.themeSelection.style, theme = s.themeSelection.theme;
    await putDraft('theme.json', { styleId: style.id, themeId: theme.id, round: data.round, ...(style.round !== data.round || theme.round !== data.round ? { styleRound: style.round, themeRound: theme.round } : {}) });
    await confirm('确认，生成高保真');
  }, 'chip primary'));
}
function renderStructure(root) {
  root.append(el('p', '', '这条涉及页面结构，需要你逐条确认：'));
  for (const item of s.artifacts.structure.items) {
    const choice = s.structureDecisions[item.id] ||= { id: item.id, decision: '', feedback: '' };
    const card = add(el('div', 'structure'), el('strong', '', item.change), el('p', 'muted', item.reason), el('p', 'muted', `影响：${item.affects.join('、')}`));
    card.dataset.structure = item.id;
    const buttons = el('div', 'quick');
    for (const [value, label] of [['accept', '同意'], ['reject', '不同意']]) {
      const node = button(label, () => { choice.decision = value; renderMessages(); }, `chip${choice.decision === value ? ' selected' : ''}`); node.setAttribute('aria-pressed', String(choice.decision === value)); buttons.append(node);
    }
    const note = el('textarea'); note.rows = 2; note.placeholder = '补充意见（可选）'; note.setAttribute('aria-label', `${item.change}：补充意见`); note.value = choice.feedback;
    note.addEventListener('input', () => { choice.feedback = note.value; }); card.append(buttons, note); root.append(card);
  }
  const ready = s.artifacts.structure.items.every(item => s.structureDecisions[item.id]?.decision);
  const generate = button('按决定生成', () => action(async () => {
    if (!ready) return;
    await putDraft('structure-changes.json', { items: s.artifacts.structure.items.map(item => s.structureDecisions[item.id]) });
    await feedback('按结构改动决定生成', [], false);
  }), 'chip primary', !ready || s.busy);
  root.append(generate);
}
async function feedback(text, attachments = s.attachments, clear = true) {
  const context = !s.contextRemoved && s.context ? s.context : undefined;
  const inputSnapshot = s.chatText, sentPaths = new Set(attachments.map(item => item.path));
  let result;
  try { result = await api.request('/tasks/feedback', { taskId: s.task.id, text, ...(context ? { context } : {}), attachments: attachments.map(item => item.path) }); }
  catch (error) {
    if (!error.status || error.status >= 500) { s.uncertain = true; syncDisabled(); }
    throw Error(`意见未确认送达：${error.message} 输入与附件已保留，请核对记录后再操作。`);
  }
  s.chat.push({ role: 'user', text }, { role: 'assistant', text: feedbackLabel(result.mode, text) });
  if (clear) {
    if (s.chatText === inputSnapshot) { s.chatText = ''; if ($('#chat-input')) $('#chat-input').value = ''; }
    s.attachments = s.attachments.filter(item => !sentPaths.has(item.path)); renderAttachments('chat');
  }
  await refreshState();
}
async function confirm(text) {
  try { await api.request('/tasks/confirm', { threadId: s.thread, taskId: s.task.id, text }); }
  catch (error) { if (!error.status || error.status >= 500) s.uncertain = true; throw Error(`继续结果待核对：${error.message} 请刷新任务状态，不要重复点击。`); }
  s.chat.push({ role: 'user', text }); await refreshState();
}
async function startTheme(text = '不用参考图，直接出选项') {
  // confirm 不接收附件；先推进到 theme，再通过统一 feedback 通道附图，由服务端选择排队或 steer。
  await confirm('确认线框，进入主题');
  s.askReference = false;
  if (s.attachments.length || s.chatText.trim()) await feedback(text);
  else render();
}
function renderPackage() {
  const article = add(el('article', 'doc package-doc'), el('h1', '', '代码包'));
  const report = s.artifacts.packageCheck, files = s.artifacts.manifest?.files || [];
  article.append(el('p', report?.ok ? 'success' : 'error', report ? (report.status === 'completed' ? `agent:check：${report.ok ? '通过' : '未通过'} · ${report.errors} 个错误 · ${files.length} 个文件` : `未验证：${report.reason || '检查未完成'} · ${files.length} 个文件`) : `检查报告尚未生成 · ${files.length} 个文件`));
  for (const item of report?.issues || []) article.append(el('p', '', typeof item === 'string' ? item : item.detail || item.message || JSON.stringify(item)));
  const tree = el('ul', 'tree');
  for (const group of packageGroups(files)) {
    if (group.directory === 'design/') tree.append(el('li', '', `design/（${group.files.length} 个设计记录）`));
    else if (!group.directory) tree.append(...group.files.map(file => el('li', '', file)));
    else tree.append(add(el('li'), el('strong', '', group.directory), add(el('ul'), ...group.files.map(file => el('li', '', file)))));
  }
  article.append(tree); return add(el('div', 'view'), article);
}
function renderHandoff() {
  const article = el('article', 'doc');
  article.append(add(el('ol', 'land-progress'), ...[['落地', '编码助手自动完成'], ['开发', '编码助手自动完成'], ['本机运行', '编码助手自动完成'], ['巡查', '需要你逐屏反馈'], ['修复', '按反馈循环到通过'], ['部署', '生产检查通过后']].map(([title, note]) => add(el('li'), el('b', '', title), el('span', '', note)))));
  if (s.handoffTab === 'PROMPT.md') {
    article.append(el('h1', '', '交给本地 Codex / Claude Code 自动完成'), el('p', 'muted', '复制下面这段，粘贴给你本地的编码助手。它会自动完成落地、开发和本机运行，然后带你巡查真实产品。'));
    const copy = button('复制指令', async () => {
      if (!s.artifacts.prompt) throw Error('指令尚未读取完整，不能复制。');
      await navigator.clipboard.writeText(s.artifacts.prompt); copy.textContent = '已复制 ✓'; setView('web-s8', 'copied'); s.chat.push({ role: 'assistant', text: '已复制完整指令' }); renderMessages();
    }, 'primary', !s.artifacts.prompt); copy.id = 'copy-prompt';
    article.append(copy, el('pre', 'prompt-text', s.artifacts.prompt || '指令尚未生成。'));
  } else { article.append(markdown(s.artifacts.deploy || '部署手册尚未生成。')); }
  return add(el('div', 'view'), article);
}
function dialog(title, text, controls) {
  const box = $('#dialog'); box.replaceChildren();
  const heading = el('h2', '', title); heading.id = 'dialog-title'; box.append(heading, el('p', '', text), add(el('div', 'quick'), ...controls, button('取消', () => box.close()))); box.showModal();
}
function takeover(occupant) {
  dialog('确认结束他人占用任务', `将结束 ${occupant.username} 自 ${new Date(occupant.startedAt).toLocaleString()} 开始的任务。正在运行的步骤不能强制结束。`, [actionButton('确认接管', async () => {
    await api.request('/tasks/cancel', { workflow: 'design', startedAt: occupant.startedAt, takeover: true });
    s.error = ''; $('#dialog').close();
    s.bench = await api.request('/workbench'); await boot();
  })]);
}
async function retry() {
  const snapshot = s.chatText, text = snapshot.trim();
  try { await api.request('/tasks/retry', { threadId: s.thread, taskId: s.task.id, ...(text ? { text } : {}) }); }
  catch (error) { if (!error.status || error.status >= 500) s.uncertain = true; throw error; }
  if (text) s.chat.push({ role: 'user', text });
  s.chat.push({ role: 'assistant', text: '已重新排队，正在重新生成' });
  if (s.chatText === snapshot) s.chatText = '';
  s.error = ''; await refreshState();
}
function endTask() {
  if (!s.task || s.history) return;
  dialog('结束并保存进度', '已有产物会保留，任务将停止推进。正在执行的步骤须先等待结束。', [actionButton('确认结束', async () => {
    await api.request('/tasks/cancel', { threadId: s.thread, taskId: s.task.id }); $('#dialog').close(); await refreshState();
  })]);
}
async function openHistory(file) {
  const content = await read(file);
  s.history = { file, content }; s.historyOpen = false; s.preview = null; s.outline = null;
  if (file.endsWith('.html')) await loadPreview(file, content);
  render();
}
function renderHistoryView(center) {
  setView('web-p3', 'history-readonly');
  if (s.history.file.endsWith('.html')) renderPreview(center);
  else if (s.history.file.endsWith('.md')) renderDocument(center, s.history.content, true);
  else center.append(add(el('div', 'view'), add(el('article', 'doc'), el('h1', '', s.history.file), el('pre', 'prompt-text', s.history.content))));
}
function renderHistoryDrawer() {
  $('.drawer')?.remove();
  const drawer = el('aside', 'drawer'); drawer.setAttribute('aria-label', '版本历史');
  drawer.append(add(el('div', 'panel-head'), el('strong', '', '版本历史'), button('×', () => { s.historyOpen = false; drawer.remove(); }, 'fold')));
  const body = el('div', 'drawer-body');
  for (const group of historyGroups(s.entries, s.task?.step ?? 0)) {
    const section = el('section', 'history-group'); section.dataset.stage = String(group.step); section.append(el('h2', '', group.title));
    for (const version of group.versions) {
      const node = button(`${version.label} · ${version.time}${version.confirmed ? ' · 已确认' : ''}`, () => openHistory(version.name.startsWith('package-v') ? `${version.name}/PROMPT.md` : version.name));
      node.dataset.version = version.name; section.append(node);
    }
    body.append(section);
  }
  if (!body.children.length) body.append(el('p', 'muted', '尚无历史版本。'));
  drawer.append(body); $('#main').append(drawer);
}
async function loadPreview(file, content) {
  s.outline = outlineFromHtml(content);
  const screens = s.outline.groups.flatMap(group => group.screens);
  if (!screens.some(screen => screen.id === s.selection?.screen && screen.states.includes(s.selection?.state))) s.selection = { screen: screens[0].id, state: screens[0].states[0] };
  const signed = await api.request('/previews', { path: projectPath(s.project, file) });
  const url = new URL(signed.url, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/preview/')) throw Error('预览地址无效。');
  s.preview = { ...signed, file }; s.context = s.task?.step === 3 ? { label: '主题' } : { ...s.selection, label: screens.find(screen => screen.id === s.selection.screen).title };
}
let artifactRefresh = Promise.resolve();
function refreshArtifacts(force = false) {
  artifactRefresh = artifactRefresh.catch(() => {}).then(() => loadArtifacts(force));
  return artifactRefresh;
}
async function loadArtifacts(force) {
  if (!s.project || !s.task || s.history) return;
  const task = s.task;
  const key = `${task.id}:${task.step}:${task.status}:${task.reviseCount || 0}:${task.turnId || ''}`;
  if (!force && key === s.artifactKey) return;
  s.artifactKey = key;
  try {
    let entries;
    entries = s.projectDirectory ? await listing() : await optionalDirectory(`outputs/design/${s.project.id}`);
    if (entries.length) s.projectDirectory = true;
    s.entries = entries; s.files = entries.map(entry => entry.name);
    const artifacts = {};
    const family = (name, ext, marker = 'v') => latest(s.files, name, ext, marker);
    if (task.step === 0) {
      const file = family('clarify', 'json', 'r'); if (file) artifacts.clarify = await json(file, 'clarify');
    }
    if (task.step === 1) { const file = family('prd', 'md'); if (file) artifacts.prd = await read(file); }
    s.preview = null; s.outline = null;
    if ([2, 3, 4].includes(task.step)) {
      let file;
      if (task.step === 3) {
        const candidates = family('themes', 'json', 'r');
        if (candidates) {
          artifacts.themes = await json(candidates, 'themes'); file = artifacts.themes.samples[0]?.artifact;
          // shownHistory 没有 round 字段，来源轮次必须从实际候选版本核对，不能猜 id 的命名。
          const rounds = s.files.filter(name => /^themes-r[1-9]\d*\.json$/.test(name)).sort((a, b) => Number(a.match(/r(\d+)/)[1]) - Number(b.match(/r(\d+)/)[1]));
          const results = await Promise.allSettled(rounds.map(name => name === candidates ? artifacts.themes : json(name, 'themes')));
          artifacts.themeOrigins = {};
          for (const result of results) {
            if (result.status === 'rejected') throw result.reason;
            for (const item of [...result.value.styles, ...result.value.themes]) artifacts.themeOrigins[item.id] ??= result.value.round;
          }
        }
      } else file = family(task.step === 2 ? 'wireframe' : 'prototype', 'html');
      if (file) await loadPreview(file, await read(file));
      if ([2, 4].includes(task.step)) {
        const proposal = family('structure-changes', 'json');
        if (proposal) artifacts.structure = await json(proposal, 'structure-changes');
      }
    }
    if (task.step === 5) {
      const dir = entries.filter(entry => entry.type === 'directory' && /^package-v[1-9]\d*$/.test(entry.name)).sort((a, b) => Number(a.name.slice(9)) - Number(b.name.slice(9))).at(-1)?.name;
      if (dir) {
        artifacts.packageDir = dir;
        const children = await listing(dir);
        const results = await Promise.allSettled(['manifest.json', 'PROMPT.md', 'DEPLOY.md'].map(async name => children.some(child => child.name === name) ? read(`${dir}/${name}`) : null));
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        if (results[0].value) artifacts.manifest = validateArtifact('manifest', JSON.parse(results[0].value), s.project.id);
        artifacts.prompt = results[1].value; artifacts.deploy = results[2].value;
      }
      if (entries.some(entry => entry.name === 'qa')) {
        const reports = (await listing('qa')).map(entry => entry.name);
        const file = latest(reports, 'package-check', 'json') || (reports.includes('package-check.json') && 'package-check.json');
        if (file) { artifacts.packageCheck = await json(`qa/${file}`, 'package-check'); if (dir && artifacts.packageCheck.path !== projectPath(s.project, dir)) throw Error('代码检查报告不属于当前包，请核对后再交付。'); }
      }
    }
    // 迟到的读取不能替换新步骤的产物。
    if (s.task.id !== task.id || s.task.step !== task.step || s.task.status !== task.status) return;
    s.artifacts = artifacts; s.artifactError = ''; render();
    if (task.step === 0 && task.status === 'waiting' && artifacts.clarify?.final) {
      const autoKey = `${task.id}:${artifacts.clarify.round}:${task.turnId}`;
      if (!s.autoContinued.has(autoKey)) {
        s.autoContinued.add(autoKey); s.chat.push({ role: 'assistant', text: '资料已齐，开始写 PRD' });
        try { await confirm('资料已齐，开始写 PRD'); }
        catch (error) { s.autoContinueError = true; showError(error); render(); }
      }
    }
  } catch (error) { s.artifactError = error.message; render(); }
}
function chooseTask() {
  const previous = s.task;
  const jobs = (s.state.queue?.jobs || []).filter(job => job.workflow === 'design' && job.mode !== 'append');
  s.task = jobs.find(job => s.bench.workflowActivity?.some(item => item.workflow === 'design' && item.taskIds.includes(job.id))) || jobs.at(-1) || null;
  if (previous?.id !== s.task?.id || previous?.step !== s.task?.step) {
    s.context = null; s.contextRemoved = false; s.selection = null; s.thinkingOpen = false;
    s.artifacts = {}; s.preview = null; s.outline = null; s.artifactError = ''; s.error = '';
  }
}
async function refreshState() {
  if (!s.thread) return;
  s.state = await api.request(`/state?threadId=${encodeURIComponent(s.thread)}`); chooseTask();
  // 不等待产物队列：final 澄清在产物读取中触发继续，等待自身会形成循环。
  void refreshArtifacts(); renderMessages();
}
async function connect(threadId) {
  s.subscription?.close(); s.thread = threadId;
  await api.request('/sessions/resume', { threadId });
  s.state = await api.request(`/state?threadId=${encodeURIComponent(threadId)}`); chooseTask();
  await refreshArtifacts(true);
  s.subscription = api.subscribe(threadId, event => {
    if (s.thread !== threadId) return;
    const next = reduceEvent(s.state, event);
    if (!next) { s.subscription?.resync(); return; }
    const oldTask = s.task; s.state = next; chooseTask();
    if (event.type === 'snapshot' || event.type === 'queue' || oldTask?.status !== s.task?.status) void refreshArtifacts();
    renderMessages();
  }, (status, error) => {
    s.connection = status === 'connected' ? '' : error || '连接中断，正在恢复会话……';
    if ($('#connection')) { $('#connection').textContent = s.connection; $('#connection').hidden = !s.connection; }
  });
}
async function boot() {
  if (!sessionStorage.getItem(tokenKey)) { login(); return; }
  await api.request('/auth/me'); s.bench = await api.request('/workbench');
  if (!s.bench.viewer.admin || s.bench.workflowActivity?.find(item => item.workflow === 'design')?.occupant) { render(); return; }
  const knownDrafts = (await optionalDirectory('inputs/drafts')).map(entry => entry.name);
  const drafts = await Promise.allSettled([draft('project.json', knownDrafts), draft('brief.json', knownDrafts), api.request('/sessions')]);
  for (const result of drafts) if (result.status === 'rejected') throw result.reason;
  s.project = drafts[0].value;
  if (s.project) validateArtifact('project', s.project);
  const brief = drafts[1].value; s.brief = restoreBrief(brief); s.welcome = !brief && !s.project;
  s.briefId = s.project?.id || brief?.projectId;
  s.briefAttachments = (brief?.fields?.references?.value || []).filter(value => /^inputs\/uploads\//.test(value)).map(path => ({ path, name: path.split('/').at(-1), image: /\.(png|jpe?g|webp)$/i.test(path) }));
  const activeIds = s.bench.workflowActivity?.find(item => item.workflow === 'design')?.taskIds || [];
  for (const session of drafts[2].value.sessions) {
    const state = await api.request(`/state?threadId=${encodeURIComponent(session.id)}`);
    const jobs = (state.queue?.jobs || []).filter(job => job.workflow === 'design' && job.mode !== 'append');
    if (jobs.some(job => activeIds.includes(job.id)) || (!activeIds.length && jobs.length)) { await connect(session.id); return; }
  }
  render();
}
$('#history').addEventListener('click', () => { s.historyOpen = true; renderHistoryDrawer(); });
addEventListener('pagehide', () => { clearTimeout(saveTimer); s.subscription?.close(); });
boot().catch(error => { $('#studio').setAttribute('aria-busy', 'false'); $('#main').replaceChildren(centerMessage('工作室暂时无法打开', error.message, button('重新读取', () => location.reload()))); });
