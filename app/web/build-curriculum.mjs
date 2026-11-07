import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {renderArchitecture} from '../../stages/build-architecture.mjs';
import {renderChanges} from './build-changes-page.mjs';
import {validateGlossary,linkGlossaryTerms} from './course-data.mjs';
import {renderOverview,renderGlossary} from './build-course-pages.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),repo=path.dirname(project),dir=path.join(project,'web/curriculum');
// 新增有课时的阶段时，在此补充章节名称与重点。
const chapterMetadata={
 s01:{name:'单轮问答',focus:'复用 Codex 执行闭环'},
 s02:{name:'多轮会话',focus:'输入顺序与原生历史'},
 s03:{name:'服务化',focus:'常驻服务与终端客户端'},
 s04:{name:'事件与消息',focus:'服务端排队、SSE 推送与重启核对'},
 s05:{name:'Agent 装配',focus:'定义、角色与 Skills'},
 s06:{name:'工具',focus:'工具白名单、资料边界与 MCP'},
 s07:{name:'记忆',focus:'原生记忆与服务端开关'},
 s08:{name:'数据层',focus:'持久任务与资源版本'},
 s09:{name:'知识层',focus:'可信门禁与 Wiki / RAG'},
 s10:{name:'Skill 与 Workflow',focus:'Skill 教方法，Workflow 管边界和终点'},
 s11:{name:'模型网关',focus:'模型清单、能力路由与用量预算'},
 s12:{name:'部署单元',focus:'健康与就绪、容量限制、备份与恢复'}
};
export function buildCurriculumData({repository=repo,curriculumDir=dir}={}){
 const stageDirs=new Set(fs.readdirSync(path.join(repository,'stages'),{withFileTypes:true}).filter(d=>d.isDirectory()&&/^s\d\d-[a-z0-9-]+$/.test(d.name)).map(d=>d.name));
 const lessons=fs.readdirSync(path.join(curriculumDir,'lessons')).filter(f=>f.endsWith('.json')).sort().flatMap(file=>{
  if(!/^s\d\d\.json$/.test(file))throw Error('Invalid lesson filename '+file);
  const rows=JSON.parse(fs.readFileSync(path.join(curriculumDir,'lessons',file),'utf8'));
  if(!Array.isArray(rows))throw Error('Lessons must be an array: '+file);
  for(const lesson of rows){
   if(typeof lesson.stage!=='string'||!stageDirs.has(lesson.stage)||!fs.existsSync(path.join(repository,'stages',lesson.stage,'package.json')))throw Error('Invalid lesson stage '+lesson.stage);
   if(!lesson.stage.startsWith(file.slice(0,3)+'-'))throw Error('Lesson stage does not match filename: '+lesson.id+' '+file);
  }
  return rows;
 });
 const manifest=JSON.parse(fs.readFileSync(path.join(curriculumDir,'experiment-manifest.json'),'utf8')).lessons;
 const experiments=new Map();
 for(const exp of manifest){if(experiments.has(exp.id))throw Error('Duplicate experiment '+exp.id);experiments.set(exp.id,exp);}
 const ids=new Set();
 for(const lesson of lessons){
  if(ids.has(lesson.id))throw Error('Duplicate lesson '+lesson.id);ids.add(lesson.id);
  if(!experiments.has(lesson.id))throw Error('Missing experiment '+lesson.id);
  if(experiments.get(lesson.id).stage!==lesson.stage)throw Error('Experiment stage mismatch '+lesson.id);
 }
 if(!lessons.length)throw Error('Curriculum has no lessons');
 if(lessons.length!==manifest.length||manifest.some(exp=>!ids.has(exp.id)))throw Error('Lessons and experiments must have equal counts and matching IDs');
 for(const lesson of lessons){
 let primaryLineCount;
 for(const s of [lesson.source,...(lesson.sources||[])]){
 const base=`stages/${lesson.stage}`;
 if(!s||typeof s.file!=='string'||!s.file.startsWith(`${base}/`)||s.file.includes('..')||s.file.includes('\\')||! /\.(mjs|json|yaml|sh)$/.test(s.file))throw Error('Invalid source path '+s?.file);
 const relative=path.relative(fs.realpathSync(path.join(repository,base)),fs.realpathSync(path.join(repository,s.file)));
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Invalid source path '+s.file);
 const text=fs.readFileSync(path.join(repository,s.file),'utf8'),at=text.indexOf(s.needle);
 if(at<0||text.indexOf(s.needle,at+1)>=0)throw Error(`Source needle missing or ambiguous: ${lesson.id} ${s.needle}`);
 const lines=text.split('\n'),anchor=text.slice(0,at).split('\n').length-1,start=Math.max(0,anchor-(s.before||0)),end=Math.min(lines.length,anchor+s.needle.split('\n').length+(s.after||0));
 s.start=start+1;s.anchor=anchor+1;s.code=lines.slice(start,end).join('\n');s.hash=createHash('sha256').update(text).digest('hex');
 if(s===lesson.source)primaryLineCount=end-start;
 }
 for(const scenario of lesson.scenarios){if(scenario.steps.length<2||scenario.steps.length>5)throw Error('Scenario must have2–5steps: '+lesson.id);for(const step of scenario.steps){if(!step.state||!step.explain||!step.actor)throw Error('Incomplete scenario: '+lesson.id);for(const line of step.lines||[])if(!Number.isInteger(line)||line<1||line>primaryLineCount)throw Error('Invalid highlight line: '+lesson.id);}}
 const exp=experiments.get(lesson.id);
 lesson.experiment={...lesson.experiment,command:exp.command,boundary:exp.boundary,observe:exp.observations,...(exp.relatedExperiments?{relatedExperiments:exp.relatedExperiments}:{}),...(exp.integrationCommand?{integrationCommand:exp.integrationCommand}:{})};
 if(!lesson.quiz.options[lesson.quiz.answer])throw Error('Invalid quiz '+lesson.id);
}
const chapters=[...new Set(lessons.map(l=>l.stage))].sort().map(stage=>{
 const id=stage.slice(0,3),metadata=chapterMetadata[id];
 if(!metadata)throw Error('Missing chapter metadata '+id);
 return {id,dir:`stages/${stage}`,...metadata};
});
return {reference:{repository:'https://github.com/shareAI-lab/learn-claude-code',commit:'ce8f9f186058939da54c9d6fead78dfb5d0fd6c3',method:'每节一个机制：问题、结构、源码、推演、实验、增量。基于本项目重新编写，不搬运其执行循环。'},chapters,lessons};
}
export function buildCurriculum({check=false}={}){
const output=buildCurriculumData(),lessons=output.lessons;
const changes=JSON.parse(fs.readFileSync(path.join(repo,'stages/changes.json'),'utf8'));
const glossary=validateGlossary(JSON.parse(fs.readFileSync(path.join(dir,'glossary.json'),'utf8')),{repository:repo,stages:changes.stages});
const course=path.join(project,'web/public/course'),serialized=JSON.stringify(output,null,2)+'\n';
// 章节长文：_handbook.html 模板 + modules/*.html 拼成 handbook.html；课程首页 index.html 由 _reader.html 生成。
const chapterStages=new Set();
const chapters=fs.readdirSync(path.join(course,'modules')).filter(f=>f.endsWith('.html')).sort().map(f=>{
 const stage=f.match(/^(s\d{2})-[a-z0-9-]+\.html$/)?.[1];
 const html=fs.readFileSync(path.join(course,'modules',f),'utf8'),id=html.match(/<section class="module" id="([^"]+)"/)?.[1],title=html.match(/<h2 class="module-title">([^<]+)<\/h2>/)?.[1];
 const number=html.match(/<span class="module-number">([^<]+)<\/span>/)?.[1];
 if(!stage||id!==`module-${stage}`||number!==stage||!title)throw Error(`章节 ${f} 的文件名、module id、阶段号或标题无效`);
 if(chapterStages.has(stage))throw Error(`章节阶段重复：${stage}`);
 chapterStages.add(stage);
 if(/\son[a-z]+=/i.test(html))throw Error(`章节 ${f} 含内联事件；交互统一放在 handbook.js`);
 return {stage,id,title,html:linkGlossaryTerms(html,glossary)};
});
const dots=chapters.map(c=>`<button class="nav-dot" data-target="${c.id}" data-tooltip="${c.stage} ${c.title}" aria-label="${c.stage} ${c.title}"></button>`).join('\n      ');
const coursePath=chapters.map(c=>`  <a href="#${c.id}">${c.stage} ${c.title}</a>`).join('\n');
const pages={'learning.js':fs.readFileSync(path.join(project,'web/public/app/learning.js'),'utf8'),'learning.css':fs.readFileSync(path.join(project,'web/public/app/learning.css'),'utf8'),'curriculum.json':serialized,'index.html':fs.readFileSync(path.join(course,'_reader.html'),'utf8'),'handbook.html':fs.readFileSync(path.join(course,'_handbook.html'),'utf8').replace('{{firstModule}}',()=>chapters[0]?.id||'main').replace('{{dots}}',()=>dots).replace('{{coursePath}}',()=>coursePath).replace('{{modules}}',()=>chapters.map(c=>c.html.trimEnd()).join('\n\n'))};
// 课程里的总架构图直接取自各阶段 README 用的同一份生成结果（stages/build-architecture.mjs），不再单独绘制。
for(const stage of fs.readdirSync(path.join(repo,'stages')).filter(d=>/^s\d\d-/.test(d))){const n=stage.slice(1,3);pages[`assets/s${n}-architecture.svg`]=n==='12'?renderArchitecture(12):fs.readFileSync(path.join(repo,'stages',stage,'images/architecture.svg'),'utf8');}
// 阶段演示页：模块与新增能力来自 stages/changes.json（node stages/build-changes.mjs 生成），机制演示来自 curriculum/mechanisms/sNN.json（每个阶段一个文件），源码按行号截取并核对。
pages['changes.html']=renderChanges(changes,Object.fromEntries(fs.readdirSync(path.join(dir,'mechanisms')).filter(f=>/^s\d\d\.json$/.test(f)).sort().map(f=>[f.slice(0,3),JSON.parse(fs.readFileSync(path.join(dir,'mechanisms',f),'utf8'))])),f=>fs.readFileSync(path.join(repo,f),'utf8'),glossary);
pages['overview.html']=renderOverview({stages:changes.stages,introduction:fs.readFileSync(path.join(repo,'stages/introduction.md'),'utf8'),chapterStages});
pages['glossary.html']=renderGlossary(glossary,changes.stages);
// The roadmap is generated by stages/build-roadmap.mjs; the course serves a copy.
pages['assets/learning-roadmap.svg']=fs.readFileSync(path.join(repo,'docs/images/learning-roadmap.svg'),'utf8');
if(check){for(const [name,body] of Object.entries(pages))if(!fs.existsSync(path.join(course,name))||fs.readFileSync(path.join(course,name),'utf8')!==body)throw Error(`课程 ${name} 不是最新；请运行 npm run course:build`);console.log(`${lessons.length} lessons, ${chapters.length} handbook chapters, ${glossary.length} glossary terms, overview, source excerpts and experiment links are current.`);}else{for(const [name,body] of Object.entries(pages))fs.writeFileSync(path.join(course,name),body);console.log(`Built ${lessons.length} source-grounded lessons, ${chapters.length} handbook chapters, overview and ${glossary.length} glossary terms.`);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildCurriculum({check:process.argv.includes('--check')});
