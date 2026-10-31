import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {stageDirs} from './server.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),repo=path.dirname(project),dir=path.join(project,'web/curriculum');
const lessons=['s01-s03.json','s04-s05.json'].flatMap(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')));
const experiments=new Map(JSON.parse(fs.readFileSync(path.join(dir,'experiment-manifest.json'),'utf8')).lessons.map(x=>[x.id,x]));
if(lessons.length!==17||experiments.size!==17)throw Error('Expected 17 lessons and experiments');
const ids=new Set();
for(const lesson of lessons){
 if(ids.has(lesson.id))throw Error('Duplicate lesson '+lesson.id);ids.add(lesson.id);
 const s=lesson.source;if(!s.file.startsWith(`${stageDirs[lesson.demo-1]}/`)||s.file.includes('..')||! /\.(mjs|json)$/.test(s.file))throw Error('Invalid source path '+s.file);
 const text=fs.readFileSync(path.join(repo,s.file),'utf8'),at=text.indexOf(s.needle);
 if(at<0||text.indexOf(s.needle,at+1)>=0)throw Error(`Source needle missing or ambiguous: ${lesson.id} ${s.needle}`);
 const lines=text.split('\n'),anchor=text.slice(0,at).split('\n').length-1,start=Math.max(0,anchor-(s.before||0)),end=Math.min(lines.length,anchor+s.needle.split('\n').length+(s.after||0));
 s.start=start+1;s.anchor=anchor+1;s.code=lines.slice(start,end).join('\n');s.hash=createHash('sha256').update(text).digest('hex');
 for(const scenario of lesson.scenarios){if(scenario.steps.length<2||scenario.steps.length>5)throw Error('Scenario must have2–5steps: '+lesson.id);for(const step of scenario.steps){if(!step.state||!step.explain||!step.actor)throw Error('Incomplete scenario: '+lesson.id);for(const line of step.lines||[])if(!Number.isInteger(line)||line<1||line>end-start)throw Error('Invalid highlight line: '+lesson.id);}}
 const exp=experiments.get(lesson.id);if(!exp)throw Error('Missing experiment '+lesson.id);
 lesson.experiment={...lesson.experiment,command:exp.command,boundary:exp.boundary,observe:exp.observations,...(exp.integrationCommand?{integrationCommand:exp.integrationCommand}:{})};
 if(!lesson.quiz.options[lesson.quiz.answer])throw Error('Invalid quiz '+lesson.id);
}
const output={reference:{repository:'https://github.com/shareAI-lab/learn-claude-code',commit:'ce8f9f186058939da54c9d6fead78dfb5d0fd6c3',method:'每节一个机制：问题、结构、源码、推演、实验、增量。基于本项目重新编写，不搬运其执行循环。'},demos:[{name:'单轮问答',focus:'复用 Codex 执行闭环'},{name:'多轮会话',focus:'输入顺序与原生历史'},{name:'可配置 Agent',focus:'装配、Skills、工具与工作区'},{name:'数据层',focus:'持久任务与资源版本'},{name:'知识层',focus:'可信门禁与 Wiki / RAG'}].map((demo,i)=>({...demo,dir:stageDirs[i]})),lessons};
const course=path.join(project,'web/public/course'),serialized=JSON.stringify(output,null,2)+'\n';
// 章节长文：_handbook.html 模板 + modules/*.html 拼成 handbook.html；课程首页 index.html 由 _reader.html 生成。
const chapters=fs.readdirSync(path.join(course,'modules')).filter(f=>f.endsWith('.html')).sort().map(f=>{const html=fs.readFileSync(path.join(course,'modules',f),'utf8'),id=html.match(/<section class="module" id="([^"]+)"/)?.[1],title=html.match(/<h2 class="module-title">([^<]+)<\/h2>/)?.[1];if(!id||!title)throw Error(`章节 ${f} 缺少 module id 或标题`);if(/\son[a-z]+=/i.test(html))throw Error(`章节 ${f} 含内联事件；交互统一放在 handbook.js`);return {id,title,html};});
const dots=chapters.map(c=>`<button class="nav-dot" data-target="${c.id}" data-tooltip="${c.title}" aria-label="${c.title}"></button>`).join('\n      ');
const pages={'curriculum.json':serialized,'index.html':fs.readFileSync(path.join(course,'_reader.html'),'utf8'),'handbook.html':fs.readFileSync(path.join(course,'_handbook.html'),'utf8').replace('{{dots}}',()=>dots).replace('{{modules}}',()=>chapters.map(c=>c.html.trimEnd()).join('\n\n'))};
if(process.argv.includes('--check')){for(const [name,body] of Object.entries(pages))if(fs.readFileSync(path.join(course,name),'utf8')!==body)throw Error(`课程 ${name} 不是最新；请运行 npm run course:build`);console.log(`${lessons.length} lessons, ${chapters.length} handbook chapters, source excerpts and experiment links are current.`);}else{for(const [name,body] of Object.entries(pages))fs.writeFileSync(path.join(course,name),body);console.log(`Built ${lessons.length} source-grounded lessons and ${chapters.length} handbook chapters.`);}
