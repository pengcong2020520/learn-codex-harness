const node = (tag, text) => { const element = document.createElement(tag); if (text != null) element.textContent = text; return element; };

export function artifactPanel(api, action) {
  const $ = id => document.getElementById(id);
  let generation = 0, listing = 0, selection = 0, selected;
  function reset() {
    generation++; listing++; selection++; selected = null;
    $('artifact-list').replaceChildren(); $('artifact-preview').replaceChildren(); $('artifact-actions').replaceChildren();
    $('artifact-status').textContent = ''; $('chat-view').classList.remove('artifacts-open');
    $('toggle-artifacts').setAttribute('aria-expanded', 'false');
  }
  async function refresh() {
    const version = ++listing, epoch = generation, files = [], problems = [];
    async function list(path, depth) {
      try {
        const result = await api.request(`/workspace?path=${encodeURIComponent(path)}`);
        if (result.truncated) problems.push(`${path} 文件较多，仅展示部分。`);
        for (const entry of result.entries) {
          const locator = `${path}/${entry.name}`;
          if (entry.type === 'file') files.push({ ...entry, path: locator });
          if (depth && entry.type === 'directory') await list(locator, depth - 1);
        }
      } catch (error) { problems.push(`${path}：${error.message}`); }
    }
    await Promise.all(['outputs', 'inputs'].map(path => list(path, 1)));
    if (version !== listing || epoch !== generation) return;
    files.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.path.localeCompare(b.path));
    $('artifact-list').replaceChildren(...files.map(file => {
      const button = node('button'); button.className = 'secondary artifact-file'; button.dataset.path = file.path;
      button.append(node('strong', file.name), node('small', `${file.path} · ${file.size} 字节 · ${new Date(file.updatedAt).toLocaleString()}`));
      button.setAttribute('aria-pressed', String(selected === file.path));
      button.onclick = () => action(button, () => open(file.path));
      return button;
    }));
    $('artifact-status').textContent = problems.join('\n') || (files.length ? '' : '暂无文件。');
  }
  async function open(path) {
    const version = ++selection, epoch = generation;
    selected = path;
    $('artifact-preview').replaceChildren(node('p', '正在读取…')); $('artifact-actions').replaceChildren();
    for (const button of $('artifact-list').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.path === path));
    const extension = path.split('.').at(-1).toLowerCase();
    try {
      if (['md', 'txt'].includes(extension)) {
        const result = await api.request(`/workspace/read?path=${encodeURIComponent(path)}`);
        if (version !== selection || epoch !== generation) return;
        $('artifact-preview').replaceChildren(node('pre', result.content));
        if (result.truncated) $('artifact-preview').append(node('p', '正文过长，当前仅展示部分内容。'));
      } else if (['html', 'png', 'jpeg', 'jpg', 'webp'].includes(extension)) {
        const result = await api.request('/previews', { path });
        if (version !== selection || epoch !== generation) return;
        const preview = node(extension === 'html' ? 'iframe' : 'img');
        if (extension === 'html') { preview.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals'); preview.title = path; }
        else preview.alt = path;
        preview.src = result.url;
        $('artifact-preview').replaceChildren(preview);
        const link = node('a', '在新窗口打开'); link.href = result.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        $('artifact-actions').append(link, node('small', `有效至 ${new Date(result.expiresAt).toLocaleTimeString()}`));
      } else $('artifact-preview').replaceChildren(node('p', '此格式暂不支持预览。'));
    } catch (error) {
      if (version !== selection || epoch !== generation) return;
      $('artifact-preview').replaceChildren(node('p', `读取失败：${error.message}`));
    }
    if (version !== selection || epoch !== generation) return;
    const reload = node('button', '刷新'); reload.className = 'secondary'; reload.onclick = () => action(reload, () => open(path));
    $('artifact-actions').append(reload);
  }
  function toggle(open) {
    $('chat-view').classList.toggle('artifacts-open', open);
    $('toggle-artifacts').setAttribute('aria-expanded', String(open));
  }
  $('toggle-artifacts').onclick = () => toggle(!$('chat-view').classList.contains('artifacts-open'));
  $('close-artifacts').onclick = () => toggle(false);
  $('refresh-artifacts').onclick = () => action($('refresh-artifacts'), refresh);
  return { refresh, reset, event(event) {
    if (event.type === 'snapshot' || (event.type === 'turn' && event.data.turn.status !== 'inProgress') ||
        (event.type === 'queue' && event.data.jobs.some(job => ['completed', 'waiting', 'needs-review'].includes(job.status)))) void action(null, refresh);
  } };
}
