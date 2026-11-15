// 此脚本内嵌在本地 HTML，以普通脚本运行，离线打开也能导出。
(() => {
  const review = JSON.parse(document.querySelector('#record').textContent);
  const $ = selector => document.querySelector(selector);
  const key = ['product-walkthrough', review.projectId, review.round, review.source.version, review.createdAt].join('/');
  const marks = ['可以', '待改', '阻塞'];
  const entries = () => review.groups.flatMap(g => g.screens.flatMap(s => s.states.map(st => ({ g, s, st }))));
  let section = review.groups[0].id;
  function element(tag, value, cls) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (cls) node.className = cls;
    return node;
  }
  function button(label, action) { const b = element('button', label); b.onclick = action; return b; }
  function field(label, value, change) {
    const box = element('label', label), input = element('textarea');
    input.value = value; input.oninput = () => { change(input.value); save(true); }; box.append(input); return box;
  }
  function stamp() { return new Date().toISOString(); }
  function tally() {
    const rows = entries();
    return [...marks, '未标'].map(mark => mark + ' ' + rows.filter(({ st }) => (st.feedback.mark || '未标') === mark).length).join(' · ');
  }
  function save(edited = false) {
    if (edited) { review.status = 'in-progress'; review.conclusion.confirmedBy = review.conclusion.confirmedAt = null; }
    review.savedAt = stamp(); review.saveVersion++;
    // 截图属于只读采集结果；草稿仅保存可编辑字段，避免图片耗尽 localStorage。
    const draft = { createdAt: review.createdAt, savedAt: review.savedAt, projectId: review.projectId, conclusion: review.conclusion, status: review.status, reviewer: review.reviewer, saveVersion: review.saveVersion,
      groups: review.groups.map(g => ({ id: g.id, feedback: g.feedback, screens: g.screens.map(s => ({ id: s.id, states: s.states.map(st => ({ state: st.state, feedback: st.feedback, exclusion: st.exclusion })) })) })) };
    try { localStorage.setItem(key, JSON.stringify(draft)); $('#saved').textContent = '已自动保存在本机'; }
    catch { $('#saved').textContent = '自动保存失败，请导出 JSON'; }
    $('#counts').textContent = '第 ' + review.round + ' 轮 · ' + tally();
  }
  function restoreFeedback(target, source) {
    if (source?.exclusion?.reason && source.exclusion.by) target.exclusion = source.exclusion;
    if (typeof source?.feedback?.text === 'string' && [null, ...marks].includes(source.feedback.mark)) target.feedback = { ...source.feedback };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved?.createdAt === review.createdAt && saved.projectId === review.projectId) {
      for (const group of review.groups) {
        const old = saved.groups.find(g => g.id === group.id);
        restoreFeedback(group, old);
        for (const s of group.screens) for (const st of s.states) restoreFeedback(st, old?.screens.find(x => x.id === s.id)?.states.find(x => x.state === st.state));
      }
      Object.assign(review, { conclusion: saved.conclusion, status: saved.status, reviewer: saved.reviewer, saveVersion: saved.saveVersion, savedAt: saved.savedAt || review.createdAt });
    }
  } catch { $('#saved').textContent = '无法恢复本机草稿，请核对已导出的反馈。'; }
  const feedbackLine = f => '第 ' + f.round + ' 轮 · ' + (f.mark || '流程反馈') + '\n' + f.text;
  function history(parent, list) {
    for (const f of list) parent.append(element('blockquote', feedbackLine(f)));
  }
  function diagnostic(d) {
    if (d.type === 'layout') return ['布局', d.code, d.element, d.reason].filter(Boolean).join(' · ');
    if (d.type === 'console') return ['控制台', d.reason, d.path && (d.path + (d.line ? ' 第 ' + d.line + ' 行' : '')), d.source].filter(Boolean).join(' · ');
    return [d.method, d.path, d.status, d.durationMs && d.durationMs + ' ms', d.reason].filter(Boolean).join(' ');
  }
  function card(g, s, st) {
    const article = element('article', undefined, 'screen');
    const picture = element('div'), form = element('div');
    if (st.screenshot) {
      const image = element('img'); image.src = st.screenshot; image.alt = s.title + ' · ' + st.state;
      const open = button('', () => { const full = $('#zoom img'); full.src = image.src; full.alt = image.alt; $('#zoom').showModal(); });
      open.className = 'shot'; open.setAttribute('aria-label', '放大' + image.alt); open.append(image); picture.append(open, button('放大截图', () => open.click()));
    } else picture.append(element('p', '无法复现 · ' + st.unavailableReason, 'unavailable'));
    form.append(element('h2', s.title + ' · ' + st.state));
    if (review.previousRound) form.append(element('small', { modified: '已修改', new: '新增', unknown: '待核对', unchanged: '无改动' }[st.changeStatus]));
    if (st.changeEvidence) form.append(element('p', '构建 v' + st.changeEvidence.version + '，已载入的脚本或样式有 ' + st.changeEvidence.files.length + ' 项摘要变化。'));
    const steps = element('ol');
    for (const line of st.reproduce) steps.append(element('li', line));
    const info = element('details'); info.append(element('summary', '诊断 · ' + st.diagnostics.length + ' 项'));
    for (const d of st.diagnostics) info.append(element('p', diagnostic(d)));
    form.append(steps, info); history(form, st.previousFeedback);
    form.append(field('本屏反馈', st.feedback.text, text => { st.feedback.text = text; st.feedback.updatedAt = stamp(); }));
    const choices = element('div', undefined, 'marks');
    for (const mark of marks) {
      const b = button(mark, () => {
        st.feedback.mark = st.feedback.mark === mark ? null : mark; st.feedback.updatedAt = stamp();
        for (const item of choices.children) item.setAttribute('aria-pressed', String(item.textContent === st.feedback.mark));
        save(true);
      });
      b.setAttribute('aria-pressed', String(st.feedback.mark === mark)); choices.append(b);
    }
    form.append(choices); article.append(picture, form); return article;
  }
  function render() {
    const view = $('#view'), nav = $('#nav');
    view.replaceChildren(); nav.replaceChildren();
    for (const [id, title] of [...review.groups.map(g => [g.id, g.title]), ['#summary', '汇总与结论']]) {
      const b = button(title, () => { section = id; render(); });
      if (id === section) b.className = 'active'; nav.append(b);
    }
    view.scrollTop = 0;
    const g = review.groups.find(item => item.id === section);
    if (g) {
      view.append(element('h1', g.title));
      for (const s of g.screens) for (const st of s.states) view.append(card(g, s, st));
      const end = element('div', undefined, 'group-feedback'); history(end, g.previousFeedback);
      end.append(field('本组流程反馈', g.feedback.text, text => { g.feedback.text = text; g.feedback.updatedAt = stamp(); })); view.append(end);
      return;
    }
    view.append(element('h1', '本轮巡查'), element('p', tally()));
    for (const { s, st } of entries().filter(({ st }) => st.feedback.mark !== '可以' || !st.screenshot)) {
      const line = element('div'); view.append(line);
      line.append(element('p', s.title + ' · ' + st.state + ' · ' + (st.feedback.mark || '未标') + (st.unavailableReason ? ' · ' + st.unavailableReason : '')), element('blockquote', st.feedback.text));
      const reason = element('input'); reason.placeholder = '排出本期的理由'; reason.setAttribute('aria-label', s.title + '排除理由'); reason.value = st.exclusion?.reason || '';
      line.append(reason, button(st.exclusion ? '取消排除' : '明确排出本期范围', () => {
        if (st.exclusion) st.exclusion = null;
        else if (review.reviewer?.trim() && reason.value.trim()) st.exclusion = { reason: reason.value.trim(), by: review.reviewer.trim(), at: stamp() };
        else { note.textContent = '请先填写验收人和排除理由。'; return; }
        save(true); render();
      }));
      if (st.exclusion) line.append(element('small', '本期已排除 · ' + st.exclusion.by));
    }
    for (const group of review.groups.filter(group => group.feedback.text)) view.append(element('h3', group.title), element('blockquote', group.feedback.text));
    for (const u of review.unmatchedPrevious) { view.append(element('h3', '未匹配历史 · ' + [u.groupId,u.screenId,u.state].filter(Boolean).join('/'))); history(view,u.previousFeedback); }
    view.append(field('本轮结论', review.conclusion.text, text => { review.conclusion.text = text; }));
    const label = element('label', '验收人 '), name = element('input'); name.value = review.reviewer || ''; label.append(name);
    name.oninput = () => { review.reviewer = name.value; save(true); };
    const note = element('p', review.status === 'complete' ? '本轮已通过 · ' + review.conclusion.confirmedBy : '');
    view.append(label, button('确认本轮巡查通过', () => {
      if (!name.value.trim() || entries().some(({ st }) => !st.exclusion && (!st.screenshot || st.feedback.mark !== '可以'))) { note.textContent = '请填写验收人并逐屏核对。待处理项需回归，或由验收人填写理由明确排出本期。'; return; }
      review.status = 'complete'; review.conclusion.confirmedBy = name.value.trim(); review.conclusion.confirmedAt = stamp(); save(); render();
    }), note);
  }
  function markdown() {
    const lines = ['# ' + review.projectId + ' · 真实产品巡查第 ' + review.round + ' 轮', '', '构建：' + review.source.artifact + ' v' + review.source.version, '计划：' + review.plan, '上一轮：' + (review.previousRound ?? '无'), '状态：' + review.status, '保存版本：' + review.saveVersion + ' · ' + review.savedAt, tally()];
    for (const g of review.groups) {
      lines.push('', '## ' + g.title);
      for (const s of g.screens) for (const st of s.states) {
        lines.push('', '### ' + s.title + ' · ' + st.state, ...st.reproduce.map((line,i) => (i+1) + '. ' + line), st.screenshot ? '截图：' + st.screenshotPath : '无法复现：' + st.unavailableReason, '诊断：' + (st.diagnostics.map(diagnostic).join('\n') || '无'), '改动：' + st.changeStatus + ' ' + JSON.stringify(st.changeEvidence || ''), '标记：' + (st.feedback.mark || '未标'), st.exclusion ? '排出本期：' + st.exclusion.reason + '（' + st.exclusion.by + '）' : '', st.feedback.text, ...st.previousFeedback.map(feedbackLine));
      }
      lines.push('本组流程反馈', g.feedback.text, ...g.previousFeedback.map(feedbackLine));
    }
    for (const u of review.unmatchedPrevious) lines.push('未匹配历史：' + [u.groupId,u.screenId,u.state].filter(Boolean).join('/'), ...u.previousFeedback.map(feedbackLine));
    lines.push('## 结论', review.conclusion.text, review.conclusion.confirmedBy || '', review.conclusion.confirmedAt || '');
    return lines.join('\n\n');
  }
  function download(ext, content) {
    const url = URL.createObjectURL(new Blob([content], { type: ext === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' }));
    const link = element('a'); link.href = url; link.download = 'walkthrough-r' + review.round + '-v' + review.saveVersion + '.' + ext; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('#summary').onclick = () => { section = '#summary'; render(); };
  $('#title').textContent = review.projectId + ' · 产品流程巡查'; $('#close').onclick = () => $('#zoom').close();
  $('#md').onclick = () => download('md', markdown()); $('#json').onclick = () => download('json', JSON.stringify(review, null, 2));
  $('#counts').textContent = '第 ' + review.round + ' 轮 · ' + tally(); if (!$('#saved').textContent) $('#saved').textContent = '本机反馈草稿';
  render();
})();
