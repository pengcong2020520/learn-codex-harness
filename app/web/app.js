import { uploadInfo } from './modules/uploads.mjs';
import { artifactPanel } from './modules/artifacts.mjs';
import { createApi } from './modules/api.mjs';
import { emptyState, reduceEvent, messagesView, hasLoss, lossMessage, pauseReason } from './modules/view-model.mjs';

const $ = id => document.getElementById(id);
const tokenKey = 'agent.web.token';
let state = emptyState(), stream, epoch = 0, selection = 0, searchVersion = 0, warnings = [], sending = false;
let pendingMessage = null, attachments = [], uploading = false;
const revisionDrafts = new Map();
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = String(text); if (className) el.className = className; return el; };
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function loginView() {
  artifacts.reset();
  attachments = []; renderAttachments();
  revisionDrafts.clear();
  epoch++; selection++; searchVersion++; stream?.close(); stream = null;
  sessionStorage.removeItem(tokenKey); state = emptyState(); pendingMessage = null; warnings = []; sending = false;
  $('chat-view').hidden = true; $('login-view').hidden = false; $('plan-dialog').close();
  $('messages').replaceChildren(); $('sessions').replaceChildren(); $('plan-content').replaceChildren();
  $('connection').hidden = true; $('message').value = ''; $('password').value = '';
  $('username').focus();
}
const api = createApi({ getToken: () => sessionStorage.getItem(tokenKey), onUnauthorized: loginView });
const artifacts = artifactPanel(api, action);
// Event callbacks always catch errors, including fetch failures and storage denial.
async function action(button, work) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  notice();
  try { await work(); } catch (error) { notice(error.status ? error.message : `操作未完成：${error.message} 请检查连接。`); }
  finally { if (button) button.disabled = false; }
}
function sidebar(open) { $('chat-view').classList.toggle('sidebar-open', open); $('toggle-sidebar').setAttribute('aria-expanded', String(open)); if (!open) $('toggle-sidebar').focus(); }
async function listSessions() {
  const version = ++searchVersion, generation = epoch;
  const result = await api.request(`/sessions?q=${encodeURIComponent($('search').value.trim())}`);
  if (version !== searchVersion || generation !== epoch) return;
  const items = result.sessions.map(session => {
    const button = node('button', session.name || session.id, 'session-button'); button.type = 'button'; button.dataset.threadId = session.id; button.setAttribute('aria-current', String(state.session?.id === session.id));
    if (hasLoss(session)) button.append(node('small', lossMessage));
    button.onclick = () => action(button, async () => {
      const selected = ++selection;
      const resumed = await api.request('/sessions/resume', { threadId: session.id });
      if (generation === epoch && selected === selection) selectSession(resumed);
    });
    return button;
  });
  $('sessions').replaceChildren(...(items.length ? items : [node('p', '暂无会话', 'muted')]));
}
function render() {
  $('session-name').textContent = state.session?.name || '新会话';
  $('model').textContent = state.session?.model || '';
  const loss = hasLoss(state.session) || state.queue?.jobs?.some(job => job.status === 'replica_missing');
  $('warnings').replaceChildren(...[...(loss ? [lossMessage] : []), ...warnings].map(text => node('p', text)));
  $('warnings').hidden = !loss && !warnings.length;
  $('queue').hidden = !state.queue?.paused;
  $('queue-reason').textContent = state.queue?.paused ? `队列已暂停：${pauseReason(state.queue)}` : '';
  const box = $('messages'), nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const focused = document.activeElement?.dataset?.actionKey;
  const cards = messagesView(state).map(row => {
    const card = node('article', null, `message ${row.role}`); card.dataset.status = row.status; card.dataset.messageId = row.id;
    const heading = node('div', null, 'message-heading');
    heading.append(node('strong', row.role === 'user' ? '你' : $('agent-name').textContent), node('span', row.label, 'status'));
    if (row.model) heading.append(node('span', row.model));
    card.append(heading, node('div', row.text, 'message-text'));
    if (row.job?.reason) card.append(node('p', row.job.reason, 'muted'));
    if (row.error) card.append(node('p', row.error, 'error'));
    if (row.job?.checks) for (const check of row.job.checks) if (!check.passed) card.append(node('p', check.message || [check.label, check.detail].filter(Boolean).join('：') || check.id || '验收未通过', 'error'));
    if (row.confirm) {
      if (row.job.status === 'waiting') card.append(node('p', `本步已重做 ${row.reviseCount} 次（最多 10 次）`, 'muted'));
      const buttons = node('div', null, 'actions');
      const draft = revisionDrafts.get(row.job.id) || { text: '', open: false };
      const form = node('form'); form.hidden = !draft.open;
      const labelInput = node('label', '修改意见');
      const input = node('textarea'); input.required = true; input.maxLength = 2000; input.value = draft.text;
      input.dataset.actionKey = `${row.job.id}:revision-text`;
      input.oninput = () => { draft.text = input.value; revisionDrafts.set(row.job.id, draft); };
      labelInput.append(input);
      const submit = node('button', '提交修改', 'secondary'); submit.type = 'submit'; submit.disabled = Boolean(draft.pending); submit.dataset.actionKey = `${row.job.id}:revision-submit`;
      form.append(labelInput, submit);
      form.onsubmit = event => { event.preventDefault(); void action(submit, async () => {
        if (draft.pending) return;
        draft.pending = true;
        const selected = selection;
        try {
          await api.request('/tasks/revise', { threadId: state.session.id, taskId: row.job.id, text: input.value });
          revisionDrafts.delete(row.job.id);
        } finally { draft.pending = false; if (selected === selection) render(); }
      }); };
      for (const label of row.actions) {
        const route = { '继续': '/tasks/confirm', '修改': '/tasks/revise', '结束': '/tasks/cancel' }[label];
        const button = node('button', label, 'secondary'); button.dataset.actionKey = `${row.job.id}:${route}`;
        button.setAttribute('aria-label', `${label}任务：${row.job.text.slice(0, 40)}`);
        button.type = 'button';
        button.onclick = label === '修改' ? () => { draft.open = !draft.open; revisionDrafts.set(row.job.id, draft); form.hidden = !draft.open; if (draft.open) input.focus(); } : () => action(button, async () => { await api.request(route, { threadId: state.session.id, taskId: row.job.id }); });
        buttons.append(button);
      }
      card.append(buttons);
      if (row.job.status === 'waiting') card.append(form);
    }
    return card;
  });
  box.replaceChildren(...(cards.length ? cards : [node('p', '从一个问题开始。', 'empty')]));
  if (focused) [...box.querySelectorAll('[data-action-key]')].find(button => button.dataset.actionKey === focused)?.focus({ preventScroll: true });
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
function selectSession(session) {
  revisionDrafts.clear();
  stream?.close(); const selected = ++selection, generation = epoch;
  state = { ...emptyState(), session }; warnings = (session.warnings || []).map(warning => warning.message || String(warning)); pendingMessage = null;
  for (const button of $('sessions').querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.threadId === session.id));
  $('message').disabled = false; $('send').disabled = sending; $('connection').hidden = true;
  sidebar(false); render(); $('message').focus();
  stream = api.subscribe(session.id, event => {
    if (generation !== epoch || selected !== selection) return;
    if (event.type === 'fatal') notice(event.data?.message || '执行服务不可用。');
    const next = reduceEvent(state, event);
    if (!next) { stream.resync(); return; }
    state = next; render(); artifacts.event(event);
  }, (status, detail) => {
    if (generation !== epoch || selected !== selection) return;
    $('connection').hidden = status === 'connected';
    $('connection').textContent = `连接中断，正在重连${detail ? `。${detail}` : ''}`;
  });
}
async function enter() {
  const generation = epoch;
  const { user } = await api.request('/auth/me');
  if (generation !== epoch) return;
  $('username-display').textContent = user.username;
  $('login-view').hidden = true; $('chat-view').hidden = false;
  const showArtifacts = matchMedia('(min-width:1101px)').matches;
  $('chat-view').classList.toggle('artifacts-open', showArtifacts); $('toggle-artifacts').setAttribute('aria-expanded', String(showArtifacts));
  $('message').disabled = true; $('send').disabled = true;
  await Promise.all([listSessions(), artifacts.refresh(), (async () => {
    const [workbench, models] = await Promise.all([api.request('/workbench'), api.request('/models')]);
    if (generation !== epoch) return;
    $('agent-name').textContent = workbench.agent?.name || workbench.agent?.id || 'Agent';
    $('model').textContent = models.defaults?.chat || '';
  })()]);
}
$('login-form').onsubmit = event => { event.preventDefault(); void action($('login-form').querySelector('button'), async () => {
  const result = await api.request('/auth/login', { username: $('username').value, password: $('password').value });
  sessionStorage.setItem(tokenKey, result.token); $('password').value = ''; await enter();
}); };
$('logout').onclick = () => action($('logout'), async () => { await api.request('/auth/logout', {}); loginView(); });
$('new-session').onclick = () => action($('new-session'), async () => {
  const generation = epoch, selected = ++selection;
  const session = await api.request('/sessions', {});
  if (generation !== epoch || selected !== selection) return;
  selectSession(session); await listSessions();
});
$('search-form').onsubmit = event => { event.preventDefault(); void action(null, listSessions); };
function renderAttachments() {
  $('attachments').replaceChildren(...attachments.map(path => {
    const button = node('button', `${path.split('/').at(-1)} ×`, 'secondary attachment');
    button.type = 'button'; button.disabled = sending; button.setAttribute('aria-label', `移除附件 ${path}`);
    button.onclick = () => { attachments = attachments.filter(item => item !== path); renderAttachments(); };
    return button;
  }));
}
$('upload').onclick = () => { if (!sending && !uploading) $('upload-file').click(); };
$('upload-file').onchange = () => { void action($('upload'), async () => {
  const file = $('upload-file').files[0], generation = epoch;
  $('upload-file').value = '';
  if (!file || sending || uploading) return;
  if (attachments.length >= 4) throw new Error('每条消息最多 4 个附件，请先移除附件或发送。');
  const path = `inputs/uploads/${file.name}`, info = uploadInfo(path);
  if (file.size > info.limit) throw new Error(info.image ? '图片不能超过 5 MiB。' : '文本不能超过 256 KiB。');
  uploading = true;
  try {
    await api.upload(path, file, info.contentType);
    if (generation !== epoch) return;
    attachments.push(path); renderAttachments(); await artifacts.refresh();
  } finally { uploading = false; }
}); };
$('composer').onsubmit = event => { event.preventDefault(); void action($('send'), async () => {
  if (!state.session || sending || uploading || !$('message').value.trim()) return;
  const text = $('message').value.trim(), threadId = state.session.id, generation = epoch;
  // Retain the ID on uncertain network outcomes, so a manual retry cannot duplicate the task.
  if (!pendingMessage || pendingMessage.text !== text || pendingMessage.threadId !== threadId || JSON.stringify(pendingMessage.attachments) !== JSON.stringify(attachments)) pendingMessage = { threadId, text, attachments: [...attachments], mode: 'enqueue', clientMessageId: crypto.randomUUID() };
  sending = true; renderAttachments();
  try {
    await api.request('/messages', pendingMessage);
    if (generation === epoch && state.session?.id === threadId) { $('message').value = ''; pendingMessage = null; attachments = []; }
    if (generation === epoch) await listSessions();
  } finally { sending = false; renderAttachments(); }
}); };
$('message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('continue-queue').onclick = () => action($('continue-queue'), () => api.request('/queue/continue', { threadId: state.session.id }));
$('toggle-sidebar').onclick = () => { sidebar(true); $('close-sidebar').focus(); };
$('close-sidebar').onclick = () => sidebar(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape') sidebar(false); });
$('close-plan').onclick = () => $('plan-dialog').close();
$('benefits').onclick = () => action($('benefits'), async () => {
  const generation = epoch;
  const [plan, usage] = await Promise.all([api.request('/me/plan'), api.request('/usage')]);
  if (generation !== epoch) return;
  const dl = node('dl');
  const fields = [['当前权益', plan.plan?.name || plan.plan?.id || plan.plan], ['管理员豁免', plan.exempt ? '是' : '否'], ['今日权益用量', plan.used], ['每日 Token 上限', plan.limit ?? '不限'], ['最大并发任务', plan.plan?.max_concurrent_turns], ['可用 Agent', plan.plan?.agents?.join('、')], ['可用工具组', plan.plan?.tool_groups?.join('、')], ['权益重置时间', plan.resetsAt], ['统计时区', usage.timezone], ['今日请求', usage.total?.requests], ['今日 Token', usage.total?.totalTokens], ['估算费用', `${usage.total?.estimatedCost ?? 0} ${usage.currency || ''}`], ['未计价请求', usage.total?.unpricedRequests], ['预算状态', usage.budget?.reason || '未超限']];
  for (const [label, value] of fields) dl.append(node('dt', label), node('dd', value == null ? '未设置' : typeof value === 'object' ? JSON.stringify(value) : value));
  $('plan-content').replaceChildren(dl); $('plan-dialog').showModal();
});
window.addEventListener('pagehide', () => stream?.close());
void action(null, async () => { if (sessionStorage.getItem(tokenKey)) await enter(); else $('username').focus(); });
