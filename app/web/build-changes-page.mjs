// 课程里的"阶段演示"页：每个阶段先看总图上新增了哪些模块，再逐步演示这一阶段的核心机制。
// 数据：stages/changes.json（模块与新增能力）+ curriculum/mechanisms/sNN.json（机制演示，代码按行号从真实源码截取）。
// 页面本身不含脚本，动画由 /course/demos.js 驱动。
const esc = s => String(s).replace(/[&<>"']/g, v => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[v]));
import {repositoryUrl as repo, termId} from './course-data.mjs';
const surfaceName = { tools: "新增工具", routes: "新增接口", env: "新增环境变量", migrations: "新增数据迁移" };

// 截取源码并核对：起始行必须包含 expect，源码改动后行号对不上就构建失败。
export function excerpt(m, read) {
  const lines = read(m.file).split("\n");
  if (!lines[m.start - 1]?.includes(m.expect)) throw new Error(`机制 ${m.id}：${m.file} 第 ${m.start} 行不再是「${m.expect}」，请更新 mechanisms/ 里的行号`);
  if (m.end > lines.length || m.end < m.start) throw new Error(`机制 ${m.id}：行号范围无效`);
  for (const s of m.steps) if (s.lines && (s.lines[0] < m.start || s.lines[1] > m.end)) throw new Error(`机制 ${m.id}：步骤高亮超出截取范围`);
  for (const k of Object.keys(m.notes)) if (k < m.start || k > m.end) throw new Error(`机制 ${m.id}：第 ${k} 行注释超出截取范围`);
  const ids = new Set(m.actors.map(([id]) => id));
  for (const s of m.steps) for (const id of [...(s.flow || []).slice(0, 2), ...Object.keys(s.actors || {})]) if (!ids.has(id)) throw new Error(`机制 ${m.id}：未知角色 ${id}`);
  return lines.slice(m.start - 1, m.end).map((text, i) => ({ no: m.start + i, text, note: m.notes[m.start + i] || "" }));
}

// 泳道图：每个角色一条竖向泳道，消息是泳道之间的横向箭头，按步骤从上往下排。
// 常驻的角色（服务、模型）一直亮着；proc 角色（一次性的进程、脚本）只在运行时亮，没运行就变暗。
function lanes(m) {
  const n = m.actors.length, x = i => ((i + 0.5) / n) * 100, at = new Map(m.actors.map(([id], i) => [id, i]));
  const heads = m.actors.map(([id, name, kind]) => `<div class="lane-head" data-actor="${id}"${kind === "proc" ? " data-proc" : ""}><b>${esc(name)}</b><small></small></div>`).join("");
  const lines = m.actors.map(([id], i) => `<i class="lifeline" data-actor="${id}"${m.actors[i][2] === "proc" ? " data-proc" : ""} style="left:${x(i)}%"></i>`).join("");
  const rows = m.steps.map((s, i) => {
    if (!s.flow) return "";
    const [from, to, label] = s.flow, a = x(at.get(from)), b = x(at.get(to)), warn = s.warn ? " warn" : "";
    if (from === to) return `<div class="msg self${warn}" data-step="${i + 1}"><b class="no">${i + 1}</b><span class="arrow" style="left:${a}%"></span><span class="label" style="left:${a}%">${esc(label)}</span></div>`;
    return `<div class="msg ${b > a ? "right" : "left"}${warn}" data-step="${i + 1}"><b class="no">${i + 1}</b><span class="arrow" style="left:${Math.min(a, b)}%;width:${Math.abs(b - a)}%"></span><span class="label" style="left:${(a + b) / 2}%">${esc(label)}</span></div>`;
  }).join("");
  return `<div class="lanes"><div class="lane-heads" style="grid-template-columns:repeat(${n},1fr)">${heads}</div><div class="lane-body">${lines}${rows}</div></div>`;
}

function mechanism(m, read) {
  const code = excerpt(m, read);
  const data = { steps: m.steps, state0: m.state0 };
  return `<article class="mech" data-mech="${esc(JSON.stringify(data))}">
  <header><h4>${esc(m.title)}</h4><p>${esc(m.question)}</p></header>
  <div class="mech-body">
    <div class="mech-play">
      ${lanes(m)}
      <p class="mech-say">点「下一步」开始演示。</p>
      <dl class="mech-state">${Object.entries(m.state0).map(([k, v]) => `<div data-key="${esc(k)}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      <div class="mech-controls"><button type="button" data-do="prev">上一步</button><button type="button" data-do="next" class="primary">下一步</button><button type="button" data-do="play">自动播放</button><button type="button" data-do="reset">重来</button><span class="mech-count">0 / ${m.steps.length}</span></div>
      <p class="mech-takeaway" hidden><b>结论</b>${esc(m.takeaway)}</p>
    </div>
    <figure class="mech-code"><figcaption><a href="${repo}/${esc(m.file)}#L${m.start}-L${m.end}" target="_blank" rel="noopener noreferrer"><code>${esc(m.file.replace(/^stages\//, ""))}</code></a></figcaption>
      <ol>${code.map(l => `<li data-line="${l.no}"><span class="no">${l.no}</span><code>${esc(l.text) || " "}</code>${l.note ? `<span class="note" style="padding-left:${l.text.match(/^ */)[0].length}ch">${esc(l.note)}</span>` : ""}</li>`).join("")}</ol>
    </figure>
  </div>
</article>`;
}

function stage(s, mechs, read, glossary) {
  const layers = new Map();
  for (const m of s.modules) layers.set(m.layer, [...(layers.get(m.layer) || []), m]);
  const surface = Object.entries(surfaceName).filter(([key]) => s.surface[key].length).map(([key, name]) => {
    const items = s.surface[key].map(x => `<code>${esc(x)}</code>`).join("");
    return s.surface[key].length > 8
      ? `<details class="chg-surface"><summary>${name} <b>${s.surface[key].length}</b></summary><div>${items}</div></details>`
      : `<div class="chg-surface"><h4>${name} <b>${s.surface[key].length}</b></h4><div>${items}</div></div>`;
  }).join("");
  const modules = [...layers].map(([layer, mods]) => `<div class="chg-layer"><span>${esc(layer)}</span>${mods.map(m => `<div class="chg-module"><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></div>`).join("")}</div>`).join("");
  return `<section class="chg-stage" id="${s.id}">
  <header><span class="chg-tag">${s.id.toUpperCase()}</span><div><h2>${esc(s.title)}</h2><p>${esc(s.summary)}</p></div></header>
  <div class="chg-overview">
    <a class="chg-figure" href="/course/assets/${s.id}-architecture.svg" target="_blank" rel="noopener noreferrer"><img src="/course/assets/${s.id}-architecture.svg" alt="${s.id.toUpperCase()} 总架构：橙色为本阶段新增的模块"></a>
    <div class="chg-modules"><h3>这一阶段加了哪些模块</h3>${modules || "<p class=\"muted\">没有新增模块框，在已有模块上加深。</p>"}${surface}</div>
  </div>
  <p class="chg-terms"><b>本阶段新术语：</b>${glossary.filter(term => term.stage === s.id).map(term => `<a href="/course/glossary.html#${esc(termId(term.term))}">${esc(term.term)}</a>`).join('、') || '暂无'}</p>
  <h3>机制演示</h3>
  ${mechs.length ? mechs.map(m => mechanism(m, read)).join("\n") : "<p class=\"muted mech-todo\">这一阶段的机制演示还在制作中。</p>"}
</section>`;
}

export function renderChanges({ stages }, mechanisms, read, glossary = []) {
  const known = new Set(stages.map(s => s.id));
  for (const id of Object.keys(mechanisms)) if (!known.has(id)) throw new Error(`mechanisms/ 里的 ${id} 不是已有阶段`);
  const nav = stages.map(s => `<a href="#${s.id}"><b>${s.id}</b><span>${esc(s.title)}</span><small>${(mechanisms[s.id] || []).length ? `${mechanisms[s.id].length} 个机制演示` : "演示制作中"}</small></a>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>阶段演示 · Codex Harness</title><link rel="stylesheet" href="/course/changes.css"><script src="/course/demos.js" defer></script></head><body>
<header class="chg-top"><a class="chg-brand" href="/course/">Agent Atelier <small>阶段演示</small></a><nav><a href="/course/overview.html">全景</a><a href="/course/">机制课程</a><a href="/course/handbook.html">章节长文</a><a href="/course/glossary.html">术语表</a><a href="/app/index.html?stage=project">进入工作台 ↗</a></nav></header>
<main class="chg-main">
<section class="chg-intro"><h1>每个阶段，多了什么机制？</h1><p>总图告诉你这一阶段在哪一层加了哪些模块；下面的演示一步一步走一遍核心机制：做了一个动作之后，谁在动、状态怎么变、为什么要这样设计。右边是对应的真实源码，逐行加了注释，当前步骤执行到的行会高亮。演示用的是固定样例，不调用模型。</p></section>
<nav class="chg-nav" aria-label="选择阶段">${nav}</nav>
${stages.map(s => stage(s, mechanisms[s.id] || [], read, glossary)).join("\n")}
</main></body></html>
`;
}
