// 章节长文（handbook.html）的交互：阅读进度、章节圆点、进入视口淡入、术语释义、架构图、流程推演、对话推演、测验。
// 全部用事件委托和 data-* 属性，页面里没有内联脚本，CSP 只需允许同源脚本。
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const navHeight = () => document.querySelector('.nav')?.offsetHeight ?? 0;
const live = el => el?.setAttribute('aria-live', 'polite');

// 阅读进度与当前章节
const bar = document.querySelector('.progress-bar');
const dots = [...document.querySelectorAll('.nav-dot')];
const chapters = dots.map(dot => document.getElementById(dot.dataset.target)).filter(Boolean);
let scrollQueued = false;
function updatePosition() {
  scrollQueued = false;
  const max = document.documentElement.scrollHeight - innerHeight;
  const ratio = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 1;
  bar?.style.setProperty('--progress', ratio.toFixed(4));
  bar?.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  const line = scrollY + navHeight() + innerHeight * 0.3;
  let current = chapters[0];
  for (const chapter of chapters) if (chapter.getBoundingClientRect().top + scrollY <= line) current = chapter;
  for (const dot of dots) {
    const active = dot.dataset.target === current?.id;
    dot.classList.toggle('is-active', active);
    dot.setAttribute('aria-current', String(active));
  }
}
const queuePosition = () => { if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(updatePosition); } };
addEventListener('scroll', queuePosition, { passive: true });
addEventListener('resize', queuePosition);
updatePosition();

// 进入视口时淡入。只处理首屏以下的元素，首屏内容和不支持 IntersectionObserver 的浏览器直接显示。
for (const group of document.querySelectorAll('.stagger-children')) {
  [...group.children].forEach((child, index) => {
    if (!child.style.getPropertyValue('--stagger-index')) child.style.setProperty('--stagger-index', String(index));
  });
}
if ('IntersectionObserver' in window && !reduceMotion) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.remove('is-pending');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -6% 0px' });
  for (const el of document.querySelectorAll('.animate-in, .stagger-children > *')) {
    if (el.getBoundingClientRect().top < innerHeight) continue;
    el.classList.add('is-pending');
    observer.observe(el);
  }
}

// 术语释义：悬停、聚焦或轻点时显示，Esc 关闭。
const tip = Object.assign(document.createElement('div'), { className: 'term-tip', id: 'term-tip', hidden: true });
tip.setAttribute('role', 'tooltip');
document.body.append(tip);
let tipFor = null;
function showTip(term) {
  const text = term.dataset.definition;
  if (!text) return;
  tipFor?.removeAttribute('aria-describedby');
  tipFor = term;
  tip.textContent = text;
  tip.hidden = false;
  term.setAttribute('aria-describedby', tip.id);
  const box = term.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
  const viewport = document.documentElement.clientWidth;
  const left = Math.max(12, Math.min(box.left + box.width / 2 - width / 2, viewport - width - 12));
  const above = box.top - height - 8 > navHeight();
  tip.style.left = `${left + scrollX}px`;
  tip.style.top = `${(above ? box.top - height - 8 : box.bottom + 8) + scrollY}px`;
}
function hideTip() {
  tipFor?.removeAttribute('aria-describedby');
  tipFor = null;
  tip.hidden = true;
}
for (const term of document.querySelectorAll('.term')) term.tabIndex = 0;
document.addEventListener('mouseover', event => {
  const term = event.target.closest?.('.term');
  if (term) { if (term !== tipFor) showTip(term); }
  else if (tipFor && document.activeElement !== tipFor) hideTip();
});
document.addEventListener('focusin', event => { const term = event.target.closest('.term'); term ? showTip(term) : hideTip(); });
document.addEventListener('focusout', event => { if (event.target === tipFor) hideTip(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTip(); });

// 测验：选项、提交、重置。提交与重置按钮在测验容器外，用 data-quiz 指向容器 id。
function chooseOption(option) {
  const block = option.closest('.quiz-question-block');
  for (const each of block.querySelectorAll('.quiz-option')) {
    each.classList.toggle('is-selected', each === option);
    each.setAttribute('aria-pressed', String(each === option));
  }
  setFeedback(block.querySelector('.quiz-feedback'), '', '', '');
}
function setFeedback(feedback, kind, title, text) {
  if (!feedback) return;
  feedback.className = kind ? `quiz-feedback ${kind}` : 'quiz-feedback';
  feedback.replaceChildren();
  if (title) feedback.append(Object.assign(document.createElement('strong'), { textContent: title }));
  if (text) feedback.append(text);
}
function checkQuiz(quiz) {
  for (const block of quiz.querySelectorAll('.quiz-question-block')) {
    const options = [...block.querySelectorAll('.quiz-option')];
    const chosen = options.find(option => option.classList.contains('is-selected'));
    const feedback = block.querySelector('.quiz-feedback');
    if (!chosen) { setFeedback(feedback, 'warning', '', '请先选择一个答案。'); continue; }
    const right = chosen.dataset.value === block.dataset.correct;
    for (const option of options) {
      option.disabled = true;
      option.classList.toggle('is-correct', option.dataset.value === block.dataset.correct);
      option.classList.toggle('is-wrong', option === chosen && !right);
    }
    setFeedback(feedback, right ? 'success' : 'error', right ? '回答正确。' : '再想一想。',
      (right ? block.dataset.explanationRight : block.dataset.explanationWrong) || '');
  }
}
function resetQuiz(quiz) {
  for (const option of quiz.querySelectorAll('.quiz-option')) {
    option.disabled = false;
    option.classList.remove('is-selected', 'is-correct', 'is-wrong');
    option.setAttribute('aria-pressed', 'false');
  }
  for (const feedback of quiz.querySelectorAll('.quiz-feedback')) setFeedback(feedback, '', '', '');
}
for (const option of document.querySelectorAll('.quiz-option')) option.setAttribute('aria-pressed', 'false');
for (const feedback of document.querySelectorAll('.quiz-feedback')) live(feedback);

// 架构图：点组件，在下方显示它的职责。
function selectComponent(component) {
  const diagram = component.closest('.arch-diagram');
  for (const each of diagram.querySelectorAll('.arch-component')) {
    each.classList.toggle('is-active', each === component);
    each.setAttribute('aria-pressed', String(each === component));
  }
  const description = diagram.querySelector('.arch-description');
  if (description) description.textContent = component.dataset.desc || '';
}
for (const description of document.querySelectorAll('.arch-description')) live(description);

document.addEventListener('click', event => {
  const target = event.target;
  const dot = target.closest('.nav-dot');
  if (dot) {
    document.getElementById(dot.dataset.target)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    history.replaceState(null, '', `#${dot.dataset.target}`);
    return;
  }
  const option = target.closest('.quiz-option');
  if (option) { if (!option.disabled) chooseOption(option); return; }
  const quizButton = target.closest('.quiz-check-btn, .quiz-reset-btn');
  const quiz = quizButton && document.getElementById(quizButton.dataset.quiz);
  if (quiz) { quizButton.classList.contains('quiz-check-btn') ? checkQuiz(quiz) : resetQuiz(quiz); return; }
  const component = target.closest('.arch-component');
  if (component) selectComponent(component);
});

// 流程推演：data-steps 里每一步高亮一个参与方；packet 为真时，数据包从 from 移到 to。
// from / to 可以写参与方的完整 id，也可以省略 "flow-" 前缀。
function setupFlow(box) {
  let steps = [];
  try { steps = JSON.parse(box.dataset.steps || '[]'); } catch { console.warn('流程步骤不是合法 JSON：', box.id); }
  const label = box.querySelector('.flow-step-label'), progress = box.querySelector('.flow-progress');
  const packet = box.querySelector('.flow-packet'), next = box.querySelector('.flow-next-btn'), reset = box.querySelector('.flow-reset-btn');
  const intro = label?.textContent ?? '';
  let index = 0;
  live(label);
  if (packet) { packet.hidden = true; packet.style.removeProperty('display'); }
  const actor = id => id ? box.querySelector(`#${CSS.escape(id)}`) || box.querySelector(`#flow-${CSS.escape(id)}`) : null;
  const center = el => {
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return [a.left - b.left + a.width / 2, a.top - b.top + a.height / 2];
  };
  const place = (el, [x, y]) => { el.style.left = `${x}px`; el.style.top = `${y}px`; };
  function render() {
    if (progress) progress.textContent = `${index} / ${steps.length}`;
    if (next) next.disabled = index >= steps.length;
    if (reset) reset.disabled = index === 0;
  }
  next?.addEventListener('click', () => {
    const step = steps[index];
    if (!step) return;
    index++;
    for (const each of box.querySelectorAll('.flow-actor')) each.classList.toggle('is-active', each.id === step.highlight);
    if (label) label.textContent = step.label || '';
    const from = actor(step.from), to = actor(step.to);
    if (packet && step.packet && from && to && from !== to) {
      packet.hidden = false;
      packet.style.transition = 'none';
      place(packet, center(from));
      packet.getBoundingClientRect();
      packet.style.transition = '';
      place(packet, center(to));
    } else if (packet) packet.hidden = true;
    render();
  });
  reset?.addEventListener('click', () => {
    index = 0;
    for (const each of box.querySelectorAll('.flow-actor')) each.classList.remove('is-active');
    if (label) label.textContent = intro;
    if (packet) packet.hidden = true;
    render();
  });
  render();
}
document.querySelectorAll('.flow-animation').forEach(setupFlow);

// 对话推演：逐条显示消息，显示前先出现对方的“正在输入”。
function setupChat(box) {
  const messages = [...box.querySelectorAll('.chat-message')];
  const typing = box.querySelector('.chat-typing'), typingAvatar = typing?.querySelector('.chat-avatar');
  const progress = box.querySelector('.chat-progress');
  const next = box.querySelector('.chat-next-btn'), all = box.querySelector('.chat-all-btn'), reset = box.querySelector('.chat-reset-btn');
  const delay = reduceMotion ? 0 : 450;
  let shown = 0, timer = null, auto = false;
  for (const el of [...messages, typing]) if (el) { el.hidden = true; el.style.removeProperty('display'); }
  live(box.querySelector('.chat-messages'));
  function render() {
    if (progress) progress.textContent = `${shown} / ${messages.length} 条`;
    if (next) next.disabled = timer !== null || shown >= messages.length;
    if (all) all.disabled = auto || shown >= messages.length;
    if (reset) reset.disabled = shown === 0 && timer === null;
  }
  function step() {
    if (timer !== null || shown >= messages.length) return;
    const message = messages[shown], avatar = message.querySelector('.chat-avatar');
    if (typing) {
      if (typingAvatar && avatar) { typingAvatar.textContent = avatar.textContent; typingAvatar.style.background = avatar.style.background; }
      typing.hidden = false;
    }
    timer = setTimeout(() => {
      timer = null;
      if (typing) typing.hidden = true;
      message.hidden = false;
      shown++;
      if (shown >= messages.length) auto = false;
      render();
      if (auto) step();
    }, delay);
    render();
  }
  next?.addEventListener('click', step);
  all?.addEventListener('click', () => { auto = true; step(); });
  reset?.addEventListener('click', () => {
    clearTimeout(timer);
    timer = null;
    auto = false;
    shown = 0;
    for (const message of messages) message.hidden = true;
    if (typing) typing.hidden = true;
    render();
  });
  render();
}
document.querySelectorAll('.chat-window').forEach(setupChat);
