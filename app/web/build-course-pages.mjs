import {stages as architecture, stageModules} from '../../stages/build-architecture.mjs';
import {escapeHtml as esc, termId, sourceUrl} from './course-data.mjs';

function page(title, script, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Codex Harness</title><link rel="stylesheet" href="/course/changes.css"><link rel="stylesheet" href="/course/overview.css"><script src="/course/${script}.js" defer></script></head><body>
<a class="course-skip" href="#main">跳到正文</a>
<header class="chg-top"><a class="chg-brand" href="/course/">Agent Atelier <small>${esc(title)}</small></a><nav aria-label="课程导航"><a href="/course/overview.html"${script==='overview'?' aria-current="page"':''}>全景</a><a href="/course/">机制课程</a><a href="/course/handbook.html">章节长文</a><a href="/course/changes.html">阶段演示</a><a href="/course/glossary.html"${script==='glossary'?' aria-current="page"':''}>术语表</a><a href="/app/index.html?stage=project">工作台 ↗</a></nav></header>
<main class="chg-main course-main" id="main">${body}</main></body></html>\n`;
}

export function introductionQuestions(markdown) {
  const section = markdown.split('## 一个 Agent 完成任务，要回答六个问题')[1]?.split('\n## ')[0];
  const questions = section?.split('\n').filter(line => /^\| [①②③④⑤⑥]/.test(line)).map(line => line.split('|')[1].trim());
  if (questions?.length !== 6) throw Error('导论的六个问题表格已改变，请更新提取规则');
  return questions;
}

export function renderOverview({stages, introduction, chapterStages}) {
  const defaultIndex = Math.max(0, stages.findIndex(stage => stage.id === 's11'));
  const added = new Map();
  for (const stage of stages) for (const module of stageModules(Number(stage.id.slice(1)))) if (!added.has(module.id)) added.set(module.id, {...module, stage:stage.id});
  // Codex and the human are outside our module boxes; their first appearance is
  // taken from the architecture paths rather than assigned a new service stage.
  for (const id of ['codex','user']) {
    const first = stages.find(stage => architecture[Number(stage.id.slice(1))].path.some(([node]) => node === id));
    if (first) added.set(id, {name:id === 'codex' ? 'Codex harness（原生）' : '用户', stage:first.id});
  }
  const final = architecture[11];
  const path = final.path.map(([id, label]) => {
    const module = added.get(id);
    if (!module) throw Error(`请求路径模块没有首次出现阶段：${id}`);
    return `<li><strong>${esc(label)}</strong><span>${esc(module.name)}</span><a href="/course/changes.html#${esc(module.stage)}">${esc(module.stage)} 起</a></li>`;
  }).join('');
  const panels = stages.map((stage, index) => {
    const data = architecture[Number(stage.id.slice(1))];
    return `<section class="overview-stage" id="overview-${esc(stage.id)}" data-stage-panel="${esc(stage.id)}"${index === defaultIndex ? '' : ' hidden'} aria-labelledby="title-${esc(stage.id)}">
<header class="stage-heading"><span class="chg-tag">${esc(stage.id)}</span><h3 id="title-${esc(stage.id)}">${esc(data.title)}</h3><p>${esc(data.sub)}</p></header>
<a class="architecture-frame" href="/course/assets/${esc(stage.id)}-architecture.svg" aria-label="打开 ${esc(stage.id)} 总架构原图"><img src="/course/assets/${esc(stage.id)}-architecture.svg" alt="${esc(stage.id)} 总架构：${esc(data.title)}；橙色为本阶段新增，白色为前面阶段已有，绿色为 Codex 原生。"></a>
<h4>这一阶段新增模块</h4><ul class="overview-modules">${stage.modules.map(module => `<li><b>${esc(module.name)}</b><span>${esc(module.layer)} · ${esc(module.desc)}</span></li>`).join('') || '<li>本阶段在已有模块上加深，没有新增模块。</li>'}</ul>
<nav class="stage-links" aria-label="${esc(stage.id)} 学习入口"><a href="${esc(sourceUrl(`stages/${stage.dir}/README.md`))}">README ↗</a><a href="/course/#${esc(stage.id)}">机制课</a><a href="/course/handbook.html${chapterStages.has(stage.id) ? '#module-'+esc(stage.id) : ''}">${chapterStages.has(stage.id) ? '长文章节' : '长文待补充 · 查看已发布目录'}</a><a href="/course/changes.html#${esc(stage.id)}">阶段演示</a></nav>
</section>`;
  }).join('\n');
  return page('课程全景', 'overview', `
<section class="overview-hero"><p class="course-eyebrow">从这里开始</p><h1>这套教程带你用 Codex 的 harness 亲手做一个云端 Agent</h1><a href="/course/assets/learning-roadmap.svg" aria-label="打开学习路线原图"><img class="roadmap" src="/course/assets/learning-roadmap.svg" alt="学习路线：${esc(stages.map(stage => stage.id+' '+architecture[Number(stage.id.slice(1))].title).join(' → '))}"></a></section>
<section class="overview-section"><h2>谁负责什么</h2><div class="responsibilities"><article><h3>Codex harness 负责</h3><ul>${['agent loop','原生历史','Skills','工具调用','沙箱'].map(text=>`<li>${esc(text)}</li>`).join('')}</ul></article><article><h3>我们的程序负责</h3><ul>${['服务与客户端','排队与推送','Agent 定义','工具与资料边界','记忆开关','数据','知识与门禁','Workflow','模型网关'].map(text=>`<li>${esc(text)}</li>`).join('')}</ul></article></div><h3>一个 Agent 要回答的六个问题</h3><ul class="six-questions">${introductionQuestions(introduction).map(question=>`<li>${esc(question)}</li>`).join('')}</ul><a href="${esc(sourceUrl('stages/introduction.md#一个 Agent 完成任务，要回答六个问题'))}">阅读导论中的分工说明 ↗</a></section>
<section class="overview-section"><h2>架构怎么一步步长出来</h2><p class="muted">拖动滑块或用方向键切换阶段；点击刻度可以直接跳转。</p><div class="stage-controls"><button type="button" id="stage-prev" aria-label="上一个阶段">←</button><label for="stage-slider">阶段 <output id="stage-output" for="stage-slider">${esc(stages[defaultIndex].id)}</output></label><input id="stage-slider" type="range" min="0" max="${stages.length-1}" value="${defaultIndex}" step="1" aria-valuetext="${esc(stages[defaultIndex].id+' '+architecture[Number(stages[defaultIndex].id.slice(1))].title)}"><button type="button" id="stage-next" aria-label="下一个阶段">→</button></div>
<nav class="stage-ticks" aria-label="阶段刻度">${stages.map((stage,i)=>`<button type="button" data-stage-index="${i}" aria-controls="overview-${esc(stage.id)}" aria-pressed="${i===defaultIndex}">${esc(stage.id)}</button>`).join('')}</nav>
<p id="stage-announcement" class="sr-only" aria-live="polite"></p>${panels}</section>
<section class="overview-section"><h2>一次请求怎么走（s11 最终形态）</h2><p class="muted">沿 s11 总架构图的黑色编号走一遍；阶段标签表示这个模块最早从哪里出现。</p><ol class="request-path">${path}</ol></section>
<section class="overview-section"><h2>怎么学</h2><div class="learning-entries">${[
  ['/course/','机制课程','拆解一个机制，用源码、推演和实验验证它的行为。'],
  ['/course/handbook.html','章节长文','沿章节读清背景、概念与实现思路。'],
  ['/course/changes.html','阶段演示','对照架构增量，逐步观察请求与状态如何流动。'],
  ['/course/glossary.html','术语表','遇到陌生词时，查解释、相关概念与原始出处。'],
  ['/app/index.html?stage=project','工作台','切换阶段，体验教学样例并连接实际服务验证行为。']
].map(([href,title,description])=>`<a href="${href}"><h3>${title}</h3><p>${description}</p></a>`).join('')}</div></section>`);
}

export function renderGlossary(glossary, stages) {
  const groups = [{id:'intro',title:'导论'}, ...stages];
  return page('术语表', 'glossary', `<section class="chg-intro"><p class="course-eyebrow">边学边查</p><h1>术语表</h1><p>按首次引入的阶段查找概念，展开查看解释、关联术语与出处。</p></section>
<div class="glossary-controls"><label for="glossary-search">搜索术语、别名或简短解释</label><input id="glossary-search" type="search" placeholder="例如 Thread" autocomplete="off"><nav class="glossary-filters" aria-label="按阶段筛选"><button type="button" data-filter="all" aria-pressed="true">全部</button>${groups.map(group=>`<button type="button" data-filter="${esc(group.id)}" aria-pressed="false" title="${esc(group.title)}">${group.id==='intro'?'导论':esc(group.id)}</button>`).join('')}</nav><p id="glossary-status" role="status">共 ${glossary.length} 个术语</p><p id="glossary-empty" hidden>没有匹配的术语。试试其他关键词或选择「全部」。</p></div>
${groups.map(group=>`<section class="glossary-group" data-group="${esc(group.id)}" aria-labelledby="group-${esc(group.id)}"><h2 id="group-${esc(group.id)}">${esc(group.id==='intro'?'导论':group.id+' · '+group.title)}</h2><div class="glossary-cards">${glossary.filter(row=>row.stage===group.id).map(row=>`<article class="term-card" id="${esc(termId(row.term))}" tabindex="-1" data-search="${esc([row.term,...row.aka,row.short].join('\n'))}"><h3><a href="#${esc(termId(row.term))}">${esc(row.term)}</a></h3>${row.aka.length?`<p class="term-aka">别名：${row.aka.map(esc).join(' · ')}</p>`:''}<p>${esc(row.short)}</p><details><summary>详细解释与出处</summary><p class="term-detail">${esc(row.detail)}</p><p class="term-related">相关术语：${row.related.map(term=>`<a href="#${esc(termId(term))}">${esc(term)}</a>`).join('、') || '暂无'}</p><p class="term-source">出处：<a href="${esc(sourceUrl(row.source))}">${esc(row.source)} ↗</a></p></details></article>`).join('')}</div></section>`).join('\n')}`);
}
