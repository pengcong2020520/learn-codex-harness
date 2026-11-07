// 各阶段总架构图：所有阶段共用一张总图，模块位置固定，只按阶段切换状态（前面已有 / 本阶段新增 / 后面才有）。
// 运行：node stages/build-architecture.mjs 生成 stages/*/images/architecture.svg 和 design.md 用的细节图；加 --check 只检查是否最新。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export const dirs = ["s00-sdk-quickstart", "s01-single-turn", "s02-multi-turn", "s03-service", "s04-events-messages", "s05-agent-assembly", "s06-tools", "s07-memory", "s08-data-layer", "s09-knowledge-layer", "s10-skill-workflow", "s11-model-gateway", "s12-deploy"];
// 阶段编号取自目录名；编号可以不连续，中间留给以后插入的阶段。
export const stageNo = dirs.map(dir => Number(dir.slice(1, 3)));
const c = { bg: "#FBFBF9", ink: "#1F2933", muted: "#6B7780", faint: "#B8C0C6", line: "#E3E7EA", card: "#FFFFFF",
  accent: "#D9622B", accentBg: "#FFF3EC", green: "#2F7D62", greenBg: "#EEF7F2", greenLine: "#B5DCCB" };

// 模块：{ id, name, desc, stage 出现的阶段, col 所在列, files 对应 server/modules 下的代码（目录以 / 结尾） }。
// 布局只往后加：新的层放在最下面，新模块放在一行末尾；已有模块的位置不动，后面阶段的层不画。
const M = (id, name, desc, stage, files = [], col) => ({ id, name, desc, stage, files, col });
function entry(n) {
  const first = n === 0 ? M("sdk", "SDK 脚本", "官方 SDK 发起一轮", 0)
    : n === 1 ? M("client", "单轮客户端", "发请求、核对终态", 1)
    : n === 2 ? M("client", "多轮客户端", "只发新输入", 1)
    : n === 3 ? M("api", "HTTP 接口", "常驻服务的入口", 3, ["http/"])
    : M("api", "HTTP / SSE 接口", n < 7 ? "终端客户端接入" : "终端与浏览器接入", 3, ["http/"]);
  // s03 服务端还不排队（上一轮没结束返回 409）；s04 起排队归「任务与消息」，会话只复用 Thread、整理快照。
  const sessions = n === 3 ? M("sessions", "会话", "复用 Thread，一次一轮", 2, ["sessions/"])
    : M("sessions", "会话", "复用 Thread，整理快照", 2, ["sessions/"]);
  return [first, sessions,
    M("messages", "任务与消息", "任务排队与调度", 4, ["messages/"]), M("events", "事件推送", "状态变化推给客户端", 4, ["events/"])];
}
const layers = n => [
  { name: "接入与会话", mods: entry(n) },
  { name: "Agent 装配", mods: [M("def", "Agent 定义", "JSON 校验 + 版本哈希", 5, ["agents/"]), M("roles", "角色与 Skills", "做什么、怎么做", 5, ["role/", "codex/skills.mjs"]),
    M("tools", "工具与资料边界", "白名单 + 参数校验", 6, ["tools/", "data/files.mjs"]), M("mcp", "MCP 工具入口", "Codex 回调本地工具", 6, ["tools/mcp-server.mjs"])] },
  { name: "运行支撑", mods: [M("lifecycle", "生命周期与清理", "启停、运行目录回收", 3, ["lifecycle/", "maintenance/"]), M("memory", "记忆", "Codex 提炼，服务端管控", 7, ["memory/"])] },
  { name: "数据", mods: [M("jobs", "任务记录", n < 6 ? "任务状态，重启后可核对" : "任务状态与产物登记", 4, ["data/index.mjs", "data/jobs.mjs"]), M("pg", "PostgreSQL", "业务状态的依据", 8, ["data/database.mjs", "data/repository.mjs", "data/schema.sql", "data/legacy.mjs", "data/migrations/"]),
    M("outbox", "Outbox + Redis", "提交后再唤醒", 8, ["data/queue.mjs"]), M("versions", "资源版本", "产物可追溯来源", 8, ["data/resources.mjs"])] },
  { name: "知识与工作流", mods: [M("gate", "可信门禁", "服务端签发身份", 9, ["permissions/"]), M("wiki", "Wiki / RAG", "带原文依据的知识", 9, ["knowledge/", "tools/knowledge.mjs"]),
    M("flow", "Workflow", "步骤、确认与验收", 10, ["workflows/"]), M("approve", "审批与提权", "可以提议，不能自批", 10, ["tools/tasks.mjs"])] },
  // 网关放在靠近 Codex 的几列：Codex 的模型请求先到网关，再由网关转给各家模型。
  { name: "模型网关", mods: [M("media", "生图与生视频", "异步任务，结果存为产物", 11, ["media/", "tools/media.mjs"], 1), M("usage", "用量与预算", "超额停止派发", 11, ["usage/"], 2),
    M("router", "模型路由", "统一协议，转给上游", 11, ["gateway/"], 3)] },
  { name: "部署", mods: [M("deployment", "就绪与容量", "健康探测、限流与关闭", 12, ["deployment/"])] },
];
// 基础设施：每个阶段都需要、但不单独成章的代码，画在服务框底部的一条带里。until 表示只到哪个阶段为止算基础设施。
const infra = [{ files: "config/", name: "配置" }, { files: "storage/", name: "存储" }, { files: "codex/", name: "Codex 连接" }, { files: "role/", name: "角色文件", until: 4 }, { files: "data/paths.mjs", name: "路径" }];
const matches = (rel, files) => [].concat(files).some(f => f.endsWith("/") ? rel.startsWith(f) : rel === f);

// 本阶段画出来的模块（不含后面阶段才有的）。
const visible = n => layers(n).map(layer => ({ ...layer, mods: layer.mods.filter(m => m.stage <= n) })).filter(layer => layer.mods.length);
// 某个文件属于哪个模块：越具体的绑定越优先（tools/mcp-server.mjs 归 MCP，而不是工具注册表）。
export function moduleOf(n, rel) {
  let best = null, len = -1;
  for (const m of visible(n).flatMap(layer => layer.mods)) for (const f of m.files) if (matches(rel, f) && f.length > len) { best = m.name; len = f.length; }
  if (best) return best;
  return infra.find(i => matches(rel, i.files) && (i.until ?? Infinity) >= n)?.name ? "基础设施" : null;
}
// 检查总图和代码是否对得上：每个模块文件都要有归属，画出来的模块都要有代码。
export function checkBindings() {
  const problems = [];
  dirs.forEach((dir, i) => {
    const n = stageNo[i], base = path.join(root, dir, "server/modules");
    const files = fs.existsSync(base) ? fs.readdirSync(base, { recursive: true }).filter(f => /\.(mjs|sql)$/.test(f)).map(f => f.split(path.sep).join("/")) : [];
    for (const f of files) if (!moduleOf(n, f)) problems.push(`${dir}: server/modules/${f} 没有对应的模块框，也不在基础设施里`);
    for (const m of visible(n).flatMap(layer => layer.mods)) if (m.files.length && !files.some(f => m.files.some(b => matches(f, b)))) problems.push(`${dir}: 模块「${m.name}」在图上，但代码里找不到 ${m.files.join("、")}`);
  });
  return problems;
}
const stageList = [
  { title: "先体验：把一件事交给 Codex", sub: "用官方 SDK 发起一轮任务；读文件、跑命令、改代码这个循环由 Codex 来转。",
    path: [["user", "写一句任务"], ["sdk", "SDK 发起"], ["codex", "codex exec 执行"], ["codex", "读文件、跑命令"], ["sdk", "拿到结果"], ["user", "自己验收"]] },
  { title: "先打通一次问答", sub: "自己写客户端，经 JSON-RPC 驱动 App Server；只有本轮成功结束，才算答完。",
    path: [["user", "输入问题"], ["client", "启动并握手"], ["codex", "thread/start"], ["codex", "turn/start"], ["client", "接收事件"], ["client", "核对终态"]] },
  { title: "让同一段对话继续下去", sub: "输入先排队再发送；每轮只发新输入，历史由 Codex 原生保存，退出后可以恢复。",
    path: [["user", "连续输入"], ["sessions", "排队等上一轮"], ["client", "只发新输入"], ["codex", "复用同一 Thread"], ["codex", "原生历史"], ["client", "逐轮核对终态"]] },
  { title: "变成常驻服务：客户端走了，服务还在", sub: "服务端常驻运行、持有 Codex；终端客户端经 HTTP 提交和查看，关掉客户端不影响正在执行的一轮。",
    path: [["user", "提交一句话"], ["api", "POST /turns"], ["sessions", "复用 Thread"], ["codex", "Codex 执行一轮"], ["api", "GET /state 查看"], ["lifecycle", "常驻，定期清理"]] },
  { title: "排队搬进服务端，状态推给客户端", sub: "输入先写进任务记录，按会话先进先出逐条发给 Codex；状态变化经 SSE 推给客户端，断线重连先补快照。",
    path: [["user", "连续提交"], ["api", "POST /messages"], ["jobs", "写入任务记录"], ["messages", "按会话排队"], ["codex", "turn/start 执行"], ["events", "SSE 推送进度"]] },
  { title: "一份 JSON 装配 Agent：角色与 Skills", sub: "Agent 定义决定角色、Skill、执行策略和工作区；启动时校验，内容一变旧版本就作废，会话与排队消息都要核对版本。",
    path: [["def", "校验 Agent 定义"], ["roles", "装配角色与 Skill"], ["codex", "skills/list 核验"], ["api", "POST /messages"], ["def", "核对版本"], ["codex", "带角色执行一轮"]] },
  { title: "工具：读得到资料、存得下文章", sub: "工具来自配置，经 MCP 交给 Codex 调用；每次调用先核对白名单和参数，资料目录按用途授权，新建文件不覆盖。",
    path: [["api", "发起任务"], ["messages", "任务排队"], ["codex", "Codex 执行一轮"], ["mcp", "MCP 回调工具"], ["tools", "核对名单与参数"], ["events", "推送进度"]] },
  { title: "记忆：Codex 提炼，服务端管控", sub: "原生记忆默认关闭；总开关、读取和每个会话是否参与提炼由服务端决定，客户端只能查看、不能传路径。",
    path: [["user", "/memory contribute"], ["api", "提交参与设置"], ["memory", "查总开关与策略"], ["codex", "memoryMode/set"], ["codex", "空闲后提炼"], ["api", "GET /memory 查看"]] },
  { title: "让任务与产物有据可查", sub: "业务记录迁入 PostgreSQL，提交后经 Redis 唤醒执行；每个产物登记版本与来源。",
    path: [["api", "发起任务"], ["pg", "任务落库"], ["outbox", "提交后唤醒"], ["codex", "Codex 执行"], ["tools", "写入产物"], ["versions", "登记版本"]] },
  { title: "知识层与门禁：依据什么，能碰什么", sub: "身份由服务端签发；文件、知识、索引共用一道门禁，Wiki / RAG 保留原文依据。",
    path: [["api", "发起任务"], ["gate", "签发任务身份"], ["codex", "Codex 执行"], ["mcp", "回调工具"], ["gate", "先过门禁"], ["wiki", "查询知识"]] },
  { title: "Skill 教方法，Workflow 管边界和终点", sub: "一类任务一份配置；多步任务在关键处停下等人确认，模型可以提议提权，不能自己批准。",
    path: [["api", "发起任务"], ["flow", "进入工作流"], ["codex", "按步骤执行"], ["approve", "提议提权"], ["user", "人来确认"], ["flow", "验收完成"]] },
  { title: "模型网关：Codex 只连网关", sub: "网关统一协议、按任务把请求路由到各家模型；每轮记录 token 用量，超出预算就停止派发。",
    path: [["api", "发起任务"], ["usage", "检查预算"], ["def", "选定模型"], ["codex", "Codex 执行"], ["router", "转发到上游"], ["usage", "记录用量"]] },
  { title: "部署：健康、就绪与恢复", sub: "独立 Compose 交付；就绪探测、容量限制与备份保护持久状态。",
    path: [["api", "接收请求"], ["deployment", "检查就绪与限流"], ["messages", "限制轮次并发"], ["codex", "执行任务"], ["pg", "持久化状态"], ["deployment", "关闭与恢复"]] },
];
// 按阶段编号取：stages[11] 是 s11。
export const stages = Object.fromEntries(stageList.map((st, i) => [stageNo[i], st]));

const esc = s => String(s).replace(/[&<>"]/g, v => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[v]));

export function renderArchitecture(n) {
  const st = stages[n], a = [], W = 1600, num = new Map(), pos = {};
  st.path.forEach(([id], i) => num.set(id, [...(num.get(id) || []), i + 1]));
  const box = (x, y, w, h, fill, stroke, dash = "", r = 12) => a.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
  const t = (s, x, y, size, color, weight = 400, anchor = "start") => a.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`);
  const arrow = (d, color, dash = "") => a.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ""} marker-end="url(#m${color.slice(1)})"/>`);
  const badge = (k, x, y) => { a.push(`<circle cx="${x}" cy="${y}" r="13" fill="${c.ink}"/>`); t(k, x, y + 5, 15, "#fff", 700, "middle"); };
  const tag = `S${String(n).padStart(2, "0")}`;
  a.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="{{H}}" viewBox="0 0 ${W} {{H}}" role="img" aria-labelledby="title desc"><title id="title">${tag} 架构：${esc(st.title)}</title><desc id="desc">${esc(st.sub)} 橙色为本阶段新增，白色为前面阶段已有，绿色为 Codex 原生能力；黑色编号是一次请求经过的顺序。</desc>`);
  a.push(`<defs>${[c.faint, c.ink, c.green].map(col => `<marker id="m${col.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${col}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join("")}</defs><g font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif">`);
  a.push(`<rect x="0" y="0" width="${W}" height="{{H}}" fill="${c.bg}"/>`);
  box(48, 44, 64, 32, c.ink, c.ink, "", 8); t(tag, 80, 66, 17, "#fff", 700, "middle");
  t(st.title, 128, 70, 30, c.ink, 700); t(st.sub, 48, 112, 19, c.muted);
  [[c.card, c.line, "", "前面阶段已有", c.muted], [c.accentBg, c.accent, "", "本阶段新增", c.accent], [c.greenBg, c.greenLine, "", "Codex 原生", c.green]]
    .forEach(([f, s, d, l, col], i) => { const x = 48 + i * 170; box(x, 138, 22, 16, f, s, d, 4); t(l, x + 30, 152, 15, col); });

  box(48, 330, 120, 104, c.card, c.line); t("用户", 108, 372, 20, c.ink, 600, "middle"); t(n < 7 ? "终端" : "终端 / 浏览器", 108, 402, 14, c.muted, 400, "middle");
  pos.user = { x: 48, y: 330, w: 120, h: 104 };

  // 我们的程序：每层一行，只画到本阶段为止；s03 起常驻为服务。
  const L = visible(n), SX = 210, SY = 186, SW = 920, RH = 112, LW = 128, bw = 182, gap = 14, IH = 44;
  const SH = 24 + L.length * RH + IH;
  box(SX, SY, SW, SH, "none", c.line, "", 16);
  const label = n >= 3 ? "我们的服务" : "我们的程序";
  a.push(`<rect x="${SX + 20}" y="${SY - 11}" width="96" height="22" fill="${c.bg}"/>`); t(label, SX + 28, SY + 6, 15, c.muted, 600);
  L.forEach((layer, li) => {
    const y = SY + 22 + li * RH, isNew = layer.mods.some(m => m.stage === n);
    t(layer.name, SX + 24, y + 46, 16, isNew ? c.accent : c.ink, 600);
    if (li) a.push(`<line x1="${SX + 16}" y1="${y - 6}" x2="${SX + SW - 16}" y2="${y - 6}" stroke="${c.line}" stroke-width="1"/>`);
    layer.mods.forEach((m, mi) => {
      const x = SX + LW + (m.col ?? mi) * (bw + gap), h = 84, fresh = m.stage === n;
      pos[m.id] = { x, y, w: bw, h };
      box(x, y, bw, h, fresh ? c.accentBg : c.card, fresh ? c.accent : c.line);
      if (fresh) a.push(`<rect x="${x + 1}" y="${y + 14}" width="4" height="${h - 28}" rx="2" fill="${c.accent}"/>`);
      t(m.name, x + 16, y + 36, 17, c.ink, 600); t(m.desc, x + 16, y + 62, 14, c.muted);
    });
  });
  // 基础设施带：配置、存储、Codex 连接等，每个阶段都有，不单独成章。
  const iy = SY + 24 + L.length * RH;
  a.push(`<line x1="${SX + 16}" y1="${iy - 8}" x2="${SX + SW - 16}" y2="${iy - 8}" stroke="${c.line}" stroke-width="1"/>`);
  t("基础设施", SX + 24, iy + 20, 14, c.muted, 600);
  t(infra.filter(i => (i.until ?? Infinity) >= n && i.files !== "data/paths.mjs").map(i => i.name).join(" · "), SX + LW, iy + 20, 14, c.muted);
  const later = layers(n).filter(layer => layer.mods.every(m => m.stage > n)).map(layer => layer.name);
  if (later.length) t(`后面还会加：${later.join(" · ")}`, SX + SW - 20, iy + 20, 14, c.faint, 400, "end");

  // Codex：s00 是一轮一个进程的 codex exec，s01 起是常驻的 App Server。
  const CX = 1230, CY = 300, CW = 200, CH = 280;
  pos.codex = { x: CX, y: CY, w: CW, h: CH };
  box(CX, CY, CW, CH, c.greenBg, c.greenLine, "", 14);
  t(n ? "Codex" : "Codex CLI", CX + 20, CY + 40, 20, c.green, 700); t(n ? "App Server" : "codex exec · 一轮一进程", CX + 20, CY + 64, 15, c.green);
  (n ? ["执行循环", "原生 Skills", "原生历史"] : ["执行循环", "工具与沙箱", "本地会话"])
    .forEach((s, i) => { box(CX + 20, CY + 90 + i * 58, CW - 40, 44, c.card, c.greenLine, "", 8); t(s, CX + CW / 2, CY + 118 + i * 58, 15, c.ink, 500, "middle"); });

  const MY = n >= 11 ? pos.router.y - 8 : 380;
  box(1460, MY, 92, 120, c.card, c.line); t("模型", 1506, MY + 52, 19, c.ink, 600, "middle"); t(n >= 11 ? "各家模型" : "理解与决策", 1506, MY + 80, 13, c.muted, 400, "middle");

  arrow(`M168,382 L${SX - 4},382`, c.ink);
  arrow(`M${SX + SW},${CY + 40} L${CX - 4},${CY + 40}`, c.ink); t(n ? "JSON-RPC" : "子进程", (SX + SW + CX) / 2, CY + 28, 13, c.muted, 500, "middle");
  if (n >= 6) { arrow(`M${CX - 2},${CY + CH - 40} L${SX + SW + 4},${CY + CH - 40}`, c.green, "6 5"); t("工具回调", (SX + SW + CX) / 2, CY + CH - 52, 13, c.green, 500, "middle"); }
  if (n >= 11) {
    // 模型请求不再直连：Codex → 网关 → 各家模型。
    const gy = pos.router.y, gx = pos.router.x + pos.router.w;
    arrow(`M${CX + 60},${CY + CH} L${CX + 60},${gy + 26} L${gx + 4},${gy + 26}`, c.green); t("模型请求", CX + 70, CY + CH + 40, 13, c.green, 500);
    arrow(`M${gx},${gy + 60} L1456,${gy + 60}`, c.ink);
  } else arrow(`M${CX + CW},${MY + 60} L1456,${MY + 60}`, c.green);

  for (const [id, ks] of num) { const p = pos[id]; ks.forEach((k, i) => badge(String(k), p.x + p.w - 6 - (ks.length - 1 - i) * 30, p.y - 2)); }

  const BY = Math.max(SY + SH, 600, n >= 11 ? pos.router.y + 140 : 0) + 44, sw = (W - 96 - 5 * 20) / 6;
  t("一次请求怎么走", 48, BY, 17, c.ink, 700);
  st.path.forEach(([id, text], i) => {
    const x = 48 + i * (sw + 20), y = BY + 16, codex = id === "codex";
    box(x, y, sw, 58, codex ? c.greenBg : c.card, codex ? c.greenLine : c.line, "", 10);
    badge(String(i + 1), x + 24, y + 29); t(text, x + 46, y + 35, 16, c.ink, 500);
    if (i < st.path.length - 1) arrow(`M${x + sw + 2},${y + 29} L${x + sw + 16},${y + 29}`, c.faint);
  });
  a.push("</g></svg>\n");
  // 高度随画出来的层数变化：加了新的阶段，前面阶段的图不受影响。
  const H = BY + 110;
  return a.join("").replaceAll("{{H}}", H);
}

// 细节图：供 docs/design.md 深入阅读，按"分区 → 一行节点"排布，配色与总图一致。
// 节点类型：new 本阶段新增，old 沿用，codex Codex 原生，warn 需要注意的分支。
const details = {
  "s10-skill-workflow/images/skill-workflow.svg": {
    title: "S10 细节：一个任务怎么走完 Workflow", sub: "Skill 教方法，Workflow 管边界和终点；模型决定怎么做，权限和验收留在模型之外。",
    sections: [
      { title: "配置：由部署者定义，跟着 Agent 包走", links: ["同步", null], nodes: [
        ["new", "Agent 包", "agent.json · role.md", "skills/ · workflows/"], ["new", "CODEX_HOME/skills", "启动时同步", "只启用声明的 Skill"], ["old", "Workspace", "用户资料与产物", "不放角色与 Skill"]] },
      { title: "执行：一步一步走，权限只在本任务有效", nodes: [
        ["old", "提交任务", "/messages + workflow", "或用户确认过的提议"], ["new", "Workflow 解析", "校验参数与授权", "定本步目标和写入范围"],
        ["new", "权限门", "grants 只在本任务有效", "轮次结束即撤销"], ["codex", "Codex 执行", "怎么做由模型决定", "skill_read 读取方法"], ["new", "验收", "只看结果", "不看调了哪些工具"]] },
      { title: "一步结束后的去向", links: [null, null, null], nodes: [
        ["warn", "验收不通过", "needs-review", "不暂停队列、不重试"], ["new", "需要确认", "waiting", "/confirm 后继续"], ["old", "无需确认", "直接排队下一步", ""], ["old", "最后一步", "completed", ""]],
        note: "propose_task：需要别的 Workflow 时，模型只能提议；用户确认前不执行、不授权。" },
    ] },
  "s11-model-gateway/images/model-gateway.svg": {
    title: "S11 细节：模型网关的三层作用", sub: "各家服务商的密钥只交给网关；Codex 只拿网关访问密钥。",
    sections: [
      { title: "① 统一协议", nodes: [
        ["codex", "Codex", "只说 Responses", "用网关访问密钥"], ["new", "模型网关 · Bifrost", "Responses 原样转发", "其余转 Chat / Messages"], ["old", "各家模型", "Kimi / DeepSeek / 智谱…", "密钥只在网关"]],
        note: "模型自带联网搜索：清单写 nativeTools，AGENT_WEB_SEARCH=auto / off；开搜索时只路由到有 web_search 能力的模型。" },
      { title: "② 多模型协调", nodes: [
        ["new", "模型清单", "config/models.json", "用途 · 候选 · 场景 · 能力"], ["new", "本次选谁", "步骤 > 任务 > 默认", "能力不符就换候选"], ["old", "四种用途", "对话 · 向量", "生图 · 生视频"]],
        note: "每轮记下选中的模型和来源；主模型失败时，网关自动尝试已启用的备用模型。" },
      { title: "③ 用量与预算", nodes: [
        ["warn", "派发前查预算", "超限：新任务保持排队", "在途轮次不打断"], ["old", "发起请求", "经网关到上游", ""], ["new", "用量入账", "按轮去重", "价格表估算金额"], ["new", "网关 token 限流", "日上限兜底", "超限直接拒绝"]],
        note: "运行中的请求仍会产生用量；预算和限流不保证费用精确封顶。" },
    ] },
};
const kinds = { new: [c.accentBg, c.accent], old: [c.card, c.line], codex: [c.greenBg, c.greenLine], warn: ["#FFF8E6", "#E3B341"] };

function renderDetail(d) {
  const a = [], W = 1600, X = 48, IW = W - 96, NH = 96, AG = 44;
  const box = (x, y, w, h, fill, stroke, r = 12) => a.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
  const t = (s, x, y, size, color, weight = 400, anchor = "start") => a.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`);
  let y = 150;
  for (const sec of d.sections) {
    const top = y, n = sec.nodes.length, nw = (IW - 48 - AG * (n - 1)) / n;
    const h = 56 + NH + (sec.note ? 52 : 24);
    box(X, top, IW, h, c.card, c.line, 16); t(sec.title, X + 24, top + 36, 18, c.ink, 700);
    sec.nodes.forEach(([kind, name, l1, l2], i) => {
      const x = X + 24 + i * (nw + AG), ny = top + 56, [fill, stroke] = kinds[kind];
      box(x, ny, nw, NH, fill, stroke);
      if (kind === "new") a.push(`<rect x="${x + 1}" y="${ny + 16}" width="4" height="${NH - 32}" rx="2" fill="${c.accent}"/>`);
      t(name, x + 18, ny + 34, 17, kind === "codex" ? c.green : c.ink, 650); t(l1, x + 18, ny + 60, 14, c.muted); if (l2) t(l2, x + 18, ny + 82, 14, c.muted);
      const link = sec.links ? sec.links[i] : "";
      if (i < n - 1 && link !== null) {
        const ax = x + nw + 6, ay = ny + NH / 2;
        a.push(`<path d="M${ax},${ay} L${ax + AG - 14},${ay}" fill="none" stroke="${c.ink}" stroke-width="2" marker-end="url(#m${c.ink.slice(1)})"/>`);
        if (link) t(link, ax + (AG - 8) / 2, ay - 10, 13, c.muted, 500, "middle");
      }
    });
    if (sec.note) t(sec.note, X + 24, top + 56 + NH + 34, 15, c.muted);
    y += h + 24;
  }
  const H = y + 52;
  const legend = [["new", "本阶段新增"], ["old", "沿用"], ["codex", "Codex 原生"], ["warn", "需要注意的分支"]];
  legend.forEach(([k, l], i) => { const [f, s] = kinds[k], lx = X + i * 170; box(lx, H - 44, 22, 16, f, s, 4); t(l, lx + 30, H - 30, 15, c.muted); });
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc"><title id="title">${esc(d.title)}</title><desc id="desc">${esc(d.sub)}</desc><defs><marker id="m${c.ink.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${c.ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker></defs><g font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"><rect x="0" y="0" width="${W}" height="${H}" fill="${c.bg}"/><text x="${X}" y="72" font-size="30" fill="${c.ink}" font-weight="700">${esc(d.title)}</text><text x="${X}" y="112" font-size="19" fill="${c.muted}">${esc(d.sub)}</text>`;
  return head + a.join("") + "</g></svg>\n";
}

// 某一阶段新增的模块（供增量页使用，与总图口径一致）。
export const stageModules = n => layers(n).flatMap(layer => layer.mods.filter(m => m.stage === n).map(({ id, name, desc, files }) => ({ id, layer: layer.name, name, desc, files })));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
const check = process.argv.includes("--check");
const problems = checkBindings();
if (problems.length) throw new Error(`总图和代码对不上，请更新 stages/build-architecture.mjs 里的模块绑定：\n${problems.join("\n")}`);
dirs.forEach((dir, i) => {
  // s12 独立快照保持原样；全仓登记图由课程资产承载。
  const file = stageNo[i] === 12 ? path.join(root, "../app/web/public/course/assets/s12-architecture.svg") : path.join(root, dir, "images/architecture.svg"), body = renderArchitecture(stageNo[i]);
  if (check) { if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) throw new Error(`${dir} 的架构图不是最新；请运行 node stages/build-architecture.mjs`); }
  else fs.writeFileSync(file, body);
});
for (const [rel, d] of Object.entries(details)) {
  const file = path.join(root, rel), body = renderDetail(d);
  if (check) { if (fs.readFileSync(file, "utf8") !== body) throw new Error(`${rel} 不是最新；请运行 node stages/build-architecture.mjs`); }
  else fs.writeFileSync(file, body);
}
console.log(check ? `${dirs.length} 张架构图和 ${Object.keys(details).length} 张细节图是最新的。` : `已生成 ${dirs.length} 张架构图和 ${Object.keys(details).length} 张细节图。`);
}
