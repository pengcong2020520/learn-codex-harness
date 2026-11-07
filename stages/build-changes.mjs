// 本阶段增量：逐个比较相邻两个阶段的快照，列出新增的模块，以及新增的工具、接口、环境变量和数据迁移。
// 只记"多了什么能力"，不统计代码行数：行数说明不了机制。
// 运行：node stages/build-changes.mjs 生成 stages/changes.json 与 stages/CHANGES.md；加 --check 只检查是否最新。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirs, stageNo, stages, stageModules } from "./build-architecture.mjs";

// dirs 包含独立部署 s12、s13；相邻快照继续生成 s12 → s13 增量，不代表容器清单。
const root = path.dirname(fileURLToPath(import.meta.url));
const read = (dir, f) => fs.readFileSync(path.join(root, dir, f), "utf8");

// 从源码里提取几类"对外可见"的东西，便于一眼看出这一阶段多了什么能力。
const extract = {
  tools: dir => fs.existsSync(path.join(root, dir, "config/tools")) ? fs.readdirSync(path.join(root, dir, "config/tools")).filter(f => f.endsWith(".json"))
    .flatMap(f => JSON.parse(read(dir, `config/tools/${f}`)).tools?.map(t => t.name) || []) : [],
  routes: dir => {
    const f = "server/modules/http/index.mjs";
    if (!fs.existsSync(path.join(root, dir, f))) return [];
    const source = read(dir, f);
    // s12 的公开健康接口在鉴权前按 method + pathname 分支处理。
    return [...source.matchAll(/route === ["']([A-Z]+ \/[^"']*)["']/g)].map(m => m[1])
      .concat([...source.matchAll(/request.method === ["']([A-Z]+)["'] && pathname === ["']([^"']+)["']/g)].map(m => `${m[1]} ${m[2]}`));
  },
  env: dir => fs.existsSync(path.join(root, dir, ".env.example")) ? [...read(dir, ".env.example").matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]) : [],
  migrations: dir => { const d = path.join(root, dir, "server/modules/data/migrations"); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith(".sql")).sort() : []; },
};
const added = (before, after) => [...new Set(after)].filter(x => !new Set(before).has(x));

// 第 i 个阶段和上一个已有阶段比；编号可以不连续。s00 是起点，没有上一阶段。
function diff(i) {
  const n = stageNo[i], dir = dirs[i], prev = dirs[i - 1];
  return {
    id: `s${String(n).padStart(2, "0")}`, dir, title: stages[n].title, summary: stages[n].sub, previous: prev || null,
    modules: stageModules(n).map(({ layer, name, desc }) => ({ layer, name, desc })),
    surface: Object.fromEntries(Object.entries(extract).map(([key, get]) => [key, prev ? added(get(prev), get(dir)) : []])),
  };
}

const surfaceNames = { tools: "新增工具", routes: "新增接口", env: "新增环境变量", migrations: "新增数据迁移" };
function markdown(list) {
  const out = ["# 每个阶段多了什么", "", "> 由 `node stages/build-changes.mjs` 根据各阶段快照自动生成，请不要手改。每个阶段的机制演示见课程的「阶段演示」页。", ""];
  for (const s of list) {
    out.push(`<a id="${s.id}"></a>`, "", `## ${s.id}：${s.title}`, "", s.previous ? `相比 [${s.previous}](${s.previous}/)：${s.summary}` : s.summary, "");
    if (s.modules.length) out.push(`**新增模块**：${s.modules.map(m => `${m.name}（${m.layer}，${m.desc}）`).join("；")}`, "");
    for (const [key, name] of Object.entries(surfaceNames)) if (s.surface[key].length) out.push(`**${name}**：${s.surface[key].map(x => `\`${x}\``).join("、")}`, "");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

export function build() {
  const list = dirs.map((_, i) => diff(i));
  return { "changes.json": JSON.stringify({ stages: list }, null, 2) + "\n", "CHANGES.md": markdown(list) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  for (const [name, body] of Object.entries(build())) {
    const file = path.join(root, name);
    if (check) { if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) throw new Error(`stages/${name} 不是最新；请运行 node stages/build-changes.mjs`); }
    else fs.writeFileSync(file, body);
  }
  console.log(check ? "阶段增量是最新的。" : "已生成 stages/changes.json 与 stages/CHANGES.md。");
}
