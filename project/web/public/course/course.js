// Keyboard access for glossary entries, without changing the upstream course engine.
document.querySelectorAll('.term').forEach(el=>{el.tabIndex=0;el.setAttribute('aria-label',`${el.textContent}：${el.dataset.definition||el.dataset.tooltip||''}`);});
// Translate quiz feedback while retaining the upstream validation engine.
const originalCheckQuiz=window.checkQuiz;
window.checkQuiz=id=>{originalCheckQuiz(id);document.querySelectorAll(`#${id} .quiz-feedback`).forEach(el=>{const title=el.querySelector('strong');if(title)title.textContent=el.classList.contains('success')?'回答正确。':'再想一想。';else if(el.classList.contains('warning'))el.textContent='请先选择一个答案。';});};
// Cancel pending animation on reset and prevent repeated clicks from skipping messages.
document.querySelectorAll('.chat-window').forEach(box=>{
  const messages=[...box.querySelectorAll('.chat-message')],typing=box.querySelector('.chat-typing'),progress=box.querySelector('.chat-progress');
  let index=0,timer=null,auto=false;
  const bind=(cls,fn)=>{const old=box.querySelector(cls);if(!old)return null;const button=old.cloneNode(true);old.replaceWith(button);button.addEventListener('click',fn);return button;};
  const next=bind('.chat-next-btn',()=>advance()),all=bind('.chat-all-btn',()=>{auto=true;advance();});
  bind('.chat-reset-btn',()=>{clearTimeout(timer);timer=null;auto=false;index=0;messages.forEach(m=>m.style.display='none');if(typing)typing.style.display='none';update();});
  function update(){if(progress)progress.textContent=`${index} / ${messages.length} 条`;if(next)next.disabled=timer!==null||index===messages.length;if(all)all.disabled=auto||index===messages.length;}
  function advance(){if(timer!==null||index>=messages.length)return;const msg=messages[index];if(typing){typing.style.display='flex';const from=msg.querySelector('.chat-avatar'),to=typing.querySelector('.chat-avatar');if(from&&to){to.textContent=from.textContent;to.style.background=from.style.background;}}
    timer=setTimeout(()=>{timer=null;if(typing)typing.style.display='none';msg.style.display='flex';index++;if(index===messages.length)auto=false;update();if(auto)advance();},450);update();}
  update();
});
