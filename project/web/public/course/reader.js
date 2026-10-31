import {loadCurriculum,mountLearning} from '/app/learning.js';
const root=document.querySelector('#course-reader');
let currentLesson;
async function openLesson(){try{const curriculum=await loadCurriculum();const chapter=Number(location.hash.match(/^#module-(\d)$/)?.[1]);const requested=new URLSearchParams(location.search).get('lesson');const lesson=curriculum.lessons.find(l=>l.id===requested)||(chapter&&curriculum.lessons.find(l=>l.demo===chapter))||curriculum.lessons[0];await mountLearning(root,{all:true,lessonId:lesson.id,onLessonChange(value){currentLesson=value.id;history.replaceState(null,'',`/course/?lesson=${encodeURIComponent(value.id)}`);document.title=`${value.title} · Codex Harness 机制实验室`;}});}catch(error){root.textContent=error.message;}}
window.addEventListener('hashchange',()=>void openLesson());void openLesson();
