const search = document.querySelector('#glossary-search');
const filters = [...document.querySelectorAll('[data-filter]')];
const groups = [...document.querySelectorAll('[data-group]')];
let stage = 'all';
function filter() {
  const query = search.value.trim().toLocaleLowerCase();
  let count = 0;
  for (const group of groups) {
    let shown = 0;
    for (const card of group.querySelectorAll('.term-card')) {
      card.hidden = (stage !== 'all' && group.dataset.group !== stage) || !card.dataset.search.toLocaleLowerCase().includes(query);
      if (!card.hidden) shown++;
    }
    group.hidden = shown === 0;
    count += shown;
  }
  filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === stage)));
  document.querySelector('#glossary-status').textContent = `显示 ${count} 个术语`;
  document.querySelector('#glossary-empty').hidden = count !== 0;
}
search.addEventListener('input', filter);
filters.forEach(button => button.addEventListener('click', () => { stage = button.dataset.filter; filter(); }));
function revealHash() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const card = document.getElementById(id);
  if (!card?.classList.contains('term-card')) return;
  // Related terms may be in a filtered-out stage. Reveal the destination before
  // scrolling, including on direct links and browser Back/Forward navigation.
  if (card.hidden || card.closest('[data-group]').hidden) { search.value = ''; stage = 'all'; filter(); }
  card.querySelector('details').open = true;
  card.focus({preventScroll:true});
  card.scrollIntoView({block:'start'});
}
window.addEventListener('hashchange', revealHash);
document.addEventListener('click', event => {
  const anchor = event.target.closest('a[href^="#term-"]');
  if (anchor && anchor.hash === location.hash) revealHash();
});
filter();
revealHash();
