// 课程里的"阶段增量"页：读 stages/changes.json，生成静态页面 course/changes.html（不需要脚本）。
const esc = s => String(s).replace(/[&<>"']/g, v => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[v]));
const repo = "https://github.com/pengcong2020520/learn-codex-harness/blob/main/stages";
const statusName = { added: "新增", changed: "改动", removed: "删除" };
const surfaceName = { tools: "新增工具", routes: "新增接口", env: "新增环境变量", migrations: "新增数据迁移" };

function bar(plus, minus, max) {
  // 增删行数条：长度按本阶段改动最大的文件归一，绿色为新增，红色为删除。
  const w = v => Math.max(v ? 2 : 0, Math.round((v / max) * 120));
  return `<span class="chg-bar" aria-hidden="true"><i class="plus" style="width:${w(plus)}px"></i><i class="minus" style="width:${w(minus)}px"></i></span>`;
}

function stage(s) {
  const max = Math.max(1, ...s.files.map(f => f.plus + f.minus));
  const groups = new Map();
  for (const f of s.files) groups.set(f.module, [...(groups.get(f.module) || []), f]);
  const layers = new Map();
  for (const m of s.modules) layers.set(m.layer, [...(layers.get(m.layer) || []), m]);
  const surface = Object.entries(surfaceName).filter(([key]) => s.surface[key].length).map(([key, name]) => {
    const items = s.surface[key].map(x => `<code>${esc(x)}</code>`).join("");
    return s.surface[key].length > 8
      ? `<details class="chg-surface"><summary>${name} <b>${s.surface[key].length}</b></summary><div>${items}</div></details>`
      : `<div class="chg-surface"><h4>${name} <b>${s.surface[key].length}</b></h4><div>${items}</div></div>`;
  }).join("");
  return `<section class="chg-stage" id="${s.id}">
  <header><span class="chg-tag">${s.id.toUpperCase()}</span><div><h2>${esc(s.title)}</h2><p>相比 ${esc(s.previous.slice(0, 3))}：${esc(s.summary)}</p></div></header>
  <div class="chg-stats">
    <div><b>${s.modules.length}</b><span>新增模块</span></div>
    <div><b>${s.totals.added}</b><span>新增文件</span></div>
    <div><b>${s.totals.changed}</b><span>改动文件</span></div>
    <div><b>${s.totals.removed}</b><span>删除文件</span></div>
    <div><b><em class="plus">+${s.totals.plus}</em> <em class="minus">−${s.totals.minus}</em></b><span>行数</span></div>
  </div>
  <div class="chg-overview">
    <a class="chg-figure" href="/course/assets/${s.id}-architecture.svg" target="_blank" rel="noopener noreferrer"><img src="/course/assets/${s.id}-architecture.svg" alt="${s.id.toUpperCase()} 总架构：橙色为本阶段新增的模块" loading="lazy"></a>
    <div class="chg-modules"><h3>这一阶段只加了这些</h3>${[...layers].map(([layer, mods]) => `<div class="chg-layer"><span>${esc(layer)}</span>${mods.map(m => `<div class="chg-module"><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></div>`).join("")}</div>`).join("") || "<p class=\"muted\">没有新增模块，只调整了已有模块。</p>"}${surface}</div>
  </div>
  <h3>按模块看改动的文件</h3>
  ${[...groups].map(([module, files]) => `<details class="chg-group"${files.some(f => f.status === "added") ? " open" : ""}><summary><b>${esc(module)}</b><span>${files.length} 个文件 · <em class="plus">+${files.reduce((t, f) => t + f.plus, 0)}</em> <em class="minus">−${files.reduce((t, f) => t + f.minus, 0)}</em></span></summary><ul>${files.map(f => `<li class="${f.status}"><span class="chg-status">${statusName[f.status]}</span><a href="${repo}/${esc(f.status === "removed" ? s.previous : s.dir)}/${esc(f.path)}" target="_blank" rel="noopener noreferrer"><code>${esc(f.path)}</code></a><span class="chg-lines"><em class="plus">+${f.plus}</em> <em class="minus">−${f.minus}</em></span>${bar(f.plus, f.minus, max)}</li>`).join("")}</ul></details>`).join("")}
</section>`;
}

export function renderChanges({ stages }) {
  const nav = stages.map(s => `<a href="#${s.id}"><b>${s.id}</b><span>${esc(s.title)}</span><small>+${s.modules.length} 模块</small></a>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>阶段增量 · Codex Harness</title><link rel="stylesheet" href="/course/changes.css"></head><body>
<header class="chg-top"><a class="chg-brand" href="/course/">Agent Atelier <small>阶段增量</small></a><nav><a href="/course/">机制课程</a><a href="/course/handbook.html">章节长文</a><a href="/app/index.html?stage=project">进入工作台 ↗</a></nav></header>
<main class="chg-main">
<section class="chg-intro"><h1>每个阶段，只多了哪一块？</h1><p>逐个比较相邻两个阶段的快照：新增了哪些模块、多了哪些工具、接口和配置，改了哪些文件。只统计实现代码与配置，测试、文档和课程材料不算在内。数据由 <code>node stages/build-changes.mjs</code> 自动生成。</p></section>
<nav class="chg-nav" aria-label="选择阶段">${nav}</nav>
${stages.map(stage).join("\n")}
</main></body></html>
`;
}
