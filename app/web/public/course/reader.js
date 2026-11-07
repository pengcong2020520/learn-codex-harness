import {loadCurriculum,mountLearning} from '/course/learning.js';
const root=document.querySelector('#course-reader');
const legacyStages={1:'s01',2:'s02',3:'s05',4:'s08',5:'s09'};
async function openLesson(){try{
 const curriculum=await loadCurriculum();
 const stage=location.hash.match(/^#(s\d{2})$/)?.[1]||legacyStages[location.hash.match(/^#module-([1-5])$/)?.[1]];
 const requested=new URLSearchParams(location.search).get('lesson');
 const lesson=stage?curriculum.lessons.find(l=>l.stage.slice(0,3)===stage):curriculum.lessons.find(l=>l.id===requested)||curriculum.lessons[0];
 if(stage&&!lesson){
  document.title=`${stage.toUpperCase()} · 暂无机制课程 · Codex Harness 机制实验室`;
  await mountLearning(root,{stage});
  return;
 }
 await mountLearning(root,{all:true,lessonId:lesson.id,onLessonChange(value){history.replaceState(null,'',`/course/?lesson=${encodeURIComponent(value.id)}`);document.title=`${value.title} · Codex Harness 机制实验室`;}});
}catch(error){root.textContent=error.message;}}
window.addEventListener('hashchange',()=>void openLesson());void openLesson();
