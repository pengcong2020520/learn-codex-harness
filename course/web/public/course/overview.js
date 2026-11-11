const slider = document.querySelector('#stage-slider');
const panels = [...document.querySelectorAll('[data-stage-panel]')];
const ticks = [...document.querySelectorAll('[data-stage-index]')];
const previous = document.querySelector('#stage-prev'), next = document.querySelector('#stage-next');
function showStage(value) {
  const index = Math.max(0, Math.min(panels.length - 1, Number(value)));
  slider.value = String(index);
  panels.forEach((panel, i) => { panel.hidden = i !== index; });
  ticks.forEach((tick, i) => tick.setAttribute('aria-pressed', String(i === index)));
  const panel = panels[index], name = `${panel.dataset.stagePanel} ${panel.querySelector('h3').textContent}`;
  document.querySelector('#stage-output').textContent = panel.dataset.stagePanel;
  document.querySelector('#stage-announcement').textContent = name;
  slider.setAttribute('aria-valuetext', name);
  previous.disabled = index === 0;
  next.disabled = index === panels.length - 1;
}
slider.addEventListener('input', () => showStage(slider.value));
previous.addEventListener('click', () => showStage(Number(slider.value) - 1));
next.addEventListener('click', () => showStage(Number(slider.value) + 1));
ticks.forEach(tick => tick.addEventListener('click', () => showStage(tick.dataset.stageIndex)));
showStage(slider.value);
