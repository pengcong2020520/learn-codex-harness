import { createApi } from '/ui/modules/api.mjs';
const status = document.querySelector('#status');
const root = document.querySelector('#screens');
const tokenKey = 'agent.web.token';
const api = createApi({ getToken: () => sessionStorage.getItem(tokenKey), onUnauthorized: () => { sessionStorage.removeItem(tokenKey); location.replace('/ui/?next=%2Fapp%2F'); } });
let text = '整理周报\n确认会议议程';
function render() {
  const screen = new URLSearchParams(location.hash.slice(1)).get('screen') || 'web-list';
  root.replaceChildren();
  const title = document.createElement('h2');
  const names = { 'web-list': '事项列表', 'web-create': '输入事项', 'web-review': '确认清单', 'web-result': '保存结果' };
  title.textContent = names[screen] || '页面不存在'; root.append(title);
  function button(label, target) { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', () => { location.hash = 'screen=' + target + '&state=default'; }); root.append(b); }
  if (screen === 'web-create') { const input = document.createElement('textarea'); input.setAttribute('aria-label', '今天要做的事项'); input.value = text; input.addEventListener('input', () => { text = input.value; }); root.append(input); button('检查清单', 'web-review'); }
  else { const content = document.createElement('pre'); content.textContent = screen === 'web-list' ? '清单存储尚未接通，请先完成 PROMPT.md 中的需要开发项。' : text; root.append(content); }
  if (screen === 'web-review') { const note = document.createElement('p'); note.textContent = '保存接口尚未开发，本页不会提交或模拟成功。'; root.append(note); button('修改事项', 'web-create'); }
  else if (screen === 'web-result') { const note = document.createElement('p'); note.textContent = '尚无真实保存结果，请返回并完成开发。'; root.append(note); }
  else button('输入事项', 'web-create');
  button('返回列表', 'web-list');
}
try { const { user } = await api.request('/auth/me'); status.textContent = '已登录：' + user.username; render(); addEventListener('hashchange', render); }
catch { status.textContent = '登录状态核对失败，请重新登录后继续。'; }
