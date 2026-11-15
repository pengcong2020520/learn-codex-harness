import { createApi } from '/ui/modules/api.mjs';
import { emptyState, reduceEvent, messagesView } from '/ui/modules/view-model.mjs';

const $ = id => document.getElementById(id), tokenKey = 'agent.web.token';
let state = emptyState(), stream, selection = 0, busy = false, uncertain = false;
function login() {
  stream?.close(); selection++;
  sessionStorage.removeItem(tokenKey);
  location.replace(`/ui/?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
}
const api = createApi({ getToken: () => sessionStorage.getItem(tokenKey), onUnauthorized: login });
function controls() {
  $('send').disabled = busy || uncertain || !state.session;
  $('new-session').disabled = busy;
  for (const button of $('sessions').querySelectorAll('button')) button.disabled = busy;
}
async function action(work) {
  if (busy) return;
  busy = true; controls(); $('notice').textContent = '';
  try { await work(); }
  catch (error) { $('notice').textContent = error.status ? error.message : '操作结果待核对，请刷新会话核实，不要重复发送。'; }
  finally { busy = false; controls(); }
}
function render() {
  $('messages').replaceChildren(...messagesView(state).map(row => {
    const article = document.createElement('article');
    article.className = row.role; article.dataset.status = row.status;
    article.textContent = `${row.role === 'user' ? '你' : 'Agent'} · ${row.label}\n${row.text}${row.error ? `\n${row.error}` : ''}`;
    return article;
  }));
}
function select(session) {
  stream?.close(); const selected = ++selection;
  uncertain = false; state = { ...emptyState(), session }; render();
  $('message').disabled = false;
  for (const button of $('sessions').querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.threadId === session.id));
  stream = api.subscribe(session.id, event => {
    if (selected !== selection) return;
    const next = reduceEvent(state, event);
    if (!next) { stream.resync(); return; }
    state = next; render();
  }, (status, detail) => {
    if (selected !== selection || uncertain) return;
    $('notice').textContent = status === 'connected' ? '' : detail || '连接中断，正在恢复会话状态…';
  });
}
async function list() {
  const { sessions } = await api.request('/sessions');
  $('sessions').replaceChildren(...sessions.map(session => {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = session.name || session.id; button.dataset.threadId = session.id;
    button.setAttribute('aria-current', String(state.session?.id === session.id));
    button.onclick = () => action(async () => select(await api.request('/sessions/resume', { threadId: session.id })));
    return button;
  }));
}
$('new-session').onclick = () => action(async () => { select(await api.request('/sessions', {})); await list(); });
$('message-form').onsubmit = event => {
  event.preventDefault();
  if (!state.session || uncertain || !$('message').value.trim()) return;
  void action(async () => {
    // 请求结果不明时保留输入并阻止重发，由用户恢复会话后核对。
    uncertain = true;
    await api.request('/messages', { threadId: state.session.id, clientMessageId: crypto.randomUUID(), text: $('message').value });
    uncertain = false; $('message').value = '';
  });
};
addEventListener('pagehide', () => stream?.close());
void action(async () => {
  if (!sessionStorage.getItem(tokenKey)) { login(); return; }
  const { user } = await api.request('/auth/me'); $('user').textContent = user.username;
  await list();
});
