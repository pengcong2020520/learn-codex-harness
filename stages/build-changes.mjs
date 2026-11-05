// 本阶段增量：逐个比较相邻两个阶段的快照，算出新增 / 改动 / 删除的文件，以及新增的模块、工具、接口、环境变量和数据迁移。
// 运行：node stages/build-changes.mjs 生成 stages/changes.json 与 stages/CHANGES.md；加 --check 只检查是否最新。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirs, stages, stageModules, moduleOf } from "./build-architecture.mjs";

const root = path.dirname(fileURLToPath(import.meta.url)), repo = path.dirname(root);
// 只比较"这一阶段的实现"：测试、文档、课程材料、示例、锁文件和快照说明不算增量。
const ignored = /^(tests\/|docs\/|lessons\/|images\/|examples\/|node_modules\/|\.data\/|\.runs\/)|\.md$|\.html$|package-lock\.json$|^snapshot\.json$|^\.gitignore$/;

const tracked = dir => execFileSync("git", ["ls-files", "--", `stages/${dir}`], { cwd: repo, encoding: "utf8" })
  .split("\n").filter(Boolean).map(f => f.slice(`stages/${dir}/`.length)).filter(f => !ignored.test(f));
const read = (dir, f) => fs.readFileSync(path.join(root, dir, f), "utf8");
const lines = text => text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;

// 两份文本的增删行数（LCS 太慢，用 git 自带的 diff 统计）。
function numstat(a, b) {
  try { execFileSync("git", ["diff", "--no-index", "--numstat", "--", a, b], { encoding: "utf8" }); return [0, 0]; }
  catch (error) { const [plus, minus] = String(error.stdout).trim().split(/\s+/); return [Number(plus) || 0, Number(minus) || 0]; }
}

// 文件归到哪一块：server/modules 下按总图的模块绑定，其余按目录给一个易懂的名字。
function owner(n, f) {
  if (f.startsWith("server/modules/")) return moduleOf(n, f.slice("server/modules/".length)) || "其他";
  if (f.startsWith("client/") || /^0\d-app-server|^main\.mjs$/.test(f)) return "客户端";
  if (f.startsWith("agents/")) return "Agent 定义";
  if (f.startsWith("config/tools/")) return "工具与资料边界";
  if (f.startsWith("config/")) return "配置";
  if (f.startsWith("scripts/")) return "脚本";
  if (f.startsWith("server/")) return "服务入口";
  if (f.startsWith("shared/")) return "共享代码";
  return "项目文件";
}

// 从源码里提取几类"对外可见"的东西，便于一眼看出这一阶段多了什么能力。
const extract = {
  tools: dir => fs.existsSync(path.join(root, dir, "config/tools")) ? fs.readdirSync(path.join(root, dir, "config/tools")).filter(f => f.endsWith(".json"))
    .flatMap(f => JSON.parse(read(dir, `config/tools/${f}`)).tools?.map(t => t.name) || []) : [],
  routes: dir => { const f = "server/modules/http/index.mjs"; return fs.existsSync(path.join(root, dir, f)) ? [...read(dir, f).matchAll(/route === ["']([A-Z]+ \/[^"']*)["']/g)].map(m => m[1]) : []; },
  env: dir => fs.existsSync(path.join(root, dir, ".env.example")) ? [...read(dir, ".env.example").matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]) : [],
  migrations: dir => { const d = path.join(root, dir, "server/modules/data/migrations"); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith(".sql")).sort() : []; },
};
const added = (before, after) => [...new Set(after)].filter(x => !new Set(before).has(x));

function diff(n) {
  const prev = dirs[n - 1], dir = dirs[n], before = new Set(tracked(prev)), after = tracked(dir);
  const files = [];
  for (const f of after) {
    if (!before.has(f)) { files.push({ path: f, status: "added", plus: lines(read(dir, f)), minus: 0, module: owner(n, f) }); continue; }
    if (read(prev, f) === read(dir, f)) continue;
    const [plus, minus] = numstat(path.join(root, prev, f), path.join(root, dir, f));
    files.push({ path: f, status: "changed", plus, minus, module: owner(n, f) });
  }
  for (const f of before) if (!after.includes(f)) files.push({ path: f, status: "removed", plus: 0, minus: lines(read(prev, f)), module: owner(n - 1, f) });
  files.sort((a, b) => a.module.localeCompare(b.module, "zh") || a.path.localeCompare(b.path));
  const sum = key => files.reduce((total, f) => total + f[key], 0);
  return {
    id: `s${String(n).padStart(2, "0")}`, dir, title: stages[n].title, summary: stages[n].sub, previous: prev,
    modules: stageModules(n).map(({ layer, name, desc }) => ({ layer, name, desc })),
    totals: { added: files.filter(f => f.status === "added").length, changed: files.filter(f => f.status === "changed").length, removed: files.filter(f => f.status === "removed").length, plus: sum("plus"), minus: sum("minus") },
    surface: Object.fromEntries(Object.entries(extract).map(([key, get]) => [key, added(get(prev), get(dir))])),
    files,
  };
}

const surfaceNames = { tools: "新增工具", routes: "新增接口", env: "新增环境变量", migrations: "新增数据迁移" };
function markdown(list) {
  const out = ["# 每个阶段改了什么", "", "> 由 `node stages/build-changes.mjs` 根据相邻两个阶段的快照自动生成，请不要手改。只统计实现代码与配置；测试、文档、课程材料不算在内。", ""];
  out.push("| 阶段 | 主题 | 新增文件 | 改动文件 | 删除文件 | 行数 |", "|---|---|---|---|---|---|");
  for (const s of list) out.push(`| [${s.id}](#${s.id}) | ${s.title} | ${s.totals.added} | ${s.totals.changed} | ${s.totals.removed} | +${s.totals.plus} / −${s.totals.minus} |`);
  for (const s of list) {
    out.push("", `<a id="${s.id}"></a>`, "", `## ${s.id}：${s.title}`, "", `相比 [${s.previous}](${s.previous}/)：${s.summary}`, "");
    if (s.modules.length) out.push(`**新增模块**：${s.modules.map(m => `${m.name}（${m.layer}，${m.desc}）`).join("；")}`, "");
    for (const [key, name] of Object.entries(surfaceNames)) if (s.surface[key].length) out.push(`**${name}**：${s.surface[key].map(x => `\`${x}\``).join("、")}`, "");
    out.push("| 状态 | 文件 | 所属模块 | 行数 |", "|---|---|---|---|");
    for (const f of s.files) out.push(`| ${{ added: "新增", changed: "改动", removed: "删除" }[f.status]} | [\`${f.path}\`](${f.status === "removed" ? s.previous : s.dir}/${f.path}) | ${f.module} | +${f.plus} / −${f.minus} |`);
  }
  return out.join("\n") + "\n";
}

export function build() {
  const list = dirs.slice(1).map((_, i) => diff(i + 1));
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
