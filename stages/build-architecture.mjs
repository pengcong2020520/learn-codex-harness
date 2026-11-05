// 各阶段总架构图：所有阶段共用一张总图，模块位置固定，只按阶段切换状态（前面已有 / 本阶段新增 / 后面才有）。
// 运行：node stages/build-architecture.mjs 生成 stages/*/images/architecture.svg 和 design.md 用的细节图；加 --check 只检查是否最新。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dirs = ["s00-sdk-quickstart", "s01-single-turn", "s02-multi-turn", "s03-agent-core", "s04-data-layer", "s05-knowledge-layer", "s06-skill-workflow", "s07-model-gateway"];
const c = { bg: "#FBFBF9", ink: "#1F2933", muted: "#6B7780", faint: "#B8C0C6", line: "#E3E7EA", card: "#FFFFFF",
  accent: "#D9622B", accentBg: "#FFF3EC", green: "#2F7D62", greenBg: "#EEF7F2", greenLine: "#B5DCCB" };

// 模块：[id, 名称, 一句话作用, 出现的阶段, 所在列]
function entry(n) {
  if (n === 0) return [["sdk", "SDK 脚本", "官方 SDK 发起一轮", 0]];
  if (n === 1) return [["client", "单轮客户端", "发请求、核对终态", 1]];
  if (n === 2) return [["client", "多轮客户端", "只发新输入", 1], ["sessions", "会话与排队", "先进先出，复用 Thread", 2]];
  return [["api", "HTTP / SSE 接口", "终端与浏览器接入", 3], ["sessions", "会话与排队", "先进先出，复用 Thread", 2]];
}
const layers = n => [
  { name: "接入", mods: entry(n) },
  { name: "Agent 装配", mods: [["def", "Agent 定义", "JSON 校验 + 版本哈希", 3], ["roles", "角色与 Skills", "做什么、怎么做", 3], ["tools", "工具注册表", "白名单 + 参数校验", 3], ["mcp", "MCP 工具入口", "Codex 回调本地工具", 3]] },
  { name: "数据", mods: [["pg", "PostgreSQL", "任务与业务状态", 4], ["outbox", "Outbox + Redis", "提交后再唤醒", 4], ["versions", "资源版本", "产物可追溯来源", 4]] },
  { name: "知识与工作流", mods: [["gate", "可信门禁", "服务端签发身份", 5], ["wiki", "Wiki / RAG", "带原文依据的知识", 5], ["flow", "Workflow", "步骤、确认与验收", 6], ["approve", "审批与提权", "可以提议，不能自批", 6]] },
  // 网关放在靠近 Codex 的两列：Codex 的模型请求先到网关，再由网关转给各家模型。
  { name: "模型网关", mods: [["usage", "用量与预算", "超额停止派发", 7, 2], ["router", "模型路由", "统一协议，转给上游", 7, 3]] },
];
const stages = [
  { title: "先体验：把一件事交给 Codex", sub: "用官方 SDK 发起一轮任务；读文件、跑命令、改代码这个循环由 Codex 来转。",
    path: [["user", "写一句任务"], ["sdk", "SDK 发起"], ["codex", "codex exec 执行"], ["codex", "读文件、跑命令"], ["sdk", "拿到结果"], ["user", "自己验收"]] },
  { title: "先打通一次问答", sub: "自己写客户端，经 JSON-RPC 驱动 App Server；只有本轮成功结束，才算答完。",
    path: [["user", "输入问题"], ["client", "启动并握手"], ["codex", "thread/start"], ["codex", "turn/start"], ["client", "接收事件"], ["client", "核对终态"]] },
  { title: "让同一段对话继续下去", sub: "输入先排队再发送；每轮只发新输入，历史由 Codex 原生保存，退出后可以恢复。",
    path: [["user", "连续输入"], ["sessions", "排队等上一轮"], ["client", "只发新输入"], ["codex", "复用同一 Thread"], ["codex", "原生历史"], ["client", "逐轮核对终态"]] },
  { title: "用配置装配一个能做事的 Agent", sub: "一份 JSON 决定角色、Skills、可用工具和资料边界；服务常驻，通过 HTTP / SSE 接入。",
    path: [["api", "发起任务"], ["sessions", "进入会话队列"], ["codex", "Codex 执行一轮"], ["mcp", "回调本地工具"], ["tools", "校验后执行"], ["codex", "结果交回模型"]] },
  { title: "让任务与产物有据可查", sub: "业务记录迁入 PostgreSQL，提交后经 Redis 唤醒执行；每个产物登记版本与来源。",
    path: [["api", "发起任务"], ["pg", "任务落库"], ["outbox", "提交后唤醒"], ["codex", "Codex 执行"], ["tools", "写入产物"], ["versions", "登记版本"]] },
  { title: "知识层与门禁：依据什么，能碰什么", sub: "身份由服务端签发；文件、知识、索引共用一道门禁，Wiki / RAG 保留原文依据。",
    path: [["api", "发起任务"], ["gate", "签发任务身份"], ["codex", "Codex 执行"], ["mcp", "回调工具"], ["gate", "先过门禁"], ["wiki", "查询知识"]] },
  { title: "Skill 教方法，Workflow 管边界和终点", sub: "一类任务一份配置；多步任务在关键处停下等人确认，模型可以提议提权，不能自己批准。",
    path: [["api", "发起任务"], ["flow", "进入工作流"], ["codex", "按步骤执行"], ["approve", "提议提权"], ["user", "人来确认"], ["flow", "验收完成"]] },
  { title: "模型网关：Codex 只连网关", sub: "网关统一协议、按任务把请求路由到各家模型；每轮记录 token 用量，超出预算就停止派发。",
    path: [["api", "发起任务"], ["usage", "检查预算"], ["def", "选定模型"], ["codex", "Codex 执行"], ["router", "转发到上游"], ["usage", "记录用量"]] },
];

const esc = s => String(s).replace(/[&<>"]/g, v => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[v]));

function render(n) {
  const st = stages[n], a = [], W = 1600, H = 930, num = new Map(), pos = {};
  st.path.forEach(([id], i) => num.set(id, [...(num.get(id) || []), i + 1]));
  const box = (x, y, w, h, fill, stroke, dash = "", r = 12) => a.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
  const t = (s, x, y, size, color, weight = 400, anchor = "start") => a.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`);
  const arrow = (d, color, dash = "") => a.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ""} marker-end="url(#m${color.slice(1)})"/>`);
  const badge = (k, x, y) => { a.push(`<circle cx="${x}" cy="${y}" r="13" fill="${c.ink}"/>`); t(k, x, y + 5, 15, "#fff", 700, "middle"); };
  const tag = `S${String(n).padStart(2, "0")}`;
  a.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc"><title id="title">${tag} 架构：${esc(st.title)}</title><desc id="desc">${esc(st.sub)} 橙色为本阶段新增，白色为前面阶段已有，虚线为后面阶段才有，绿色为 Codex 原生能力；黑色编号是一次请求经过的顺序。</desc>`);
  a.push(`<defs>${[c.faint, c.ink, c.green].map(col => `<marker id="m${col.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${col}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join("")}</defs><g font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif">`);
  box(0, 0, W, H, c.bg, c.bg, "", 0);
  box(48, 44, 64, 32, c.ink, c.ink, "", 8); t(tag, 80, 66, 17, "#fff", 700, "middle");
  t(st.title, 128, 70, 30, c.ink, 700); t(st.sub, 48, 112, 19, c.muted);
  [[c.card, c.line, "", "前面阶段已有", c.muted], [c.accentBg, c.accent, "", "本阶段新增", c.accent], [c.bg, c.faint, "5 5", "后面阶段才有", c.faint], [c.greenBg, c.greenLine, "", "Codex 原生", c.green]]
    .forEach(([f, s, d, l, col], i) => { const x = 48 + i * 170; box(x, 138, 22, 16, f, s, d, 4); t(l, x + 30, 152, 15, col); });

  box(48, 330, 120, 104, c.card, c.line); t("用户", 108, 372, 20, c.ink, 600, "middle"); t("终端 / 浏览器", 108, 402, 14, c.muted, 400, "middle");
  pos.user = { x: 48, y: 330, w: 120, h: 104 };

  // 我们的程序：五层，每层一行；s03 起常驻为服务。
  const L = layers(n), SX = 210, SY = 186, SW = 920, RH = 112, LW = 128, bw = 182, gap = 14;
  box(SX, SY, SW, 24 + L.length * RH, "none", c.line, "", 16);
  const label = n >= 3 ? "我们的服务" : "我们的程序";
  a.push(`<rect x="${SX + 20}" y="${SY - 11}" width="96" height="22" fill="${c.bg}"/>`); t(label, SX + 28, SY + 6, 15, c.muted, 600);
  L.forEach((layer, li) => {
    const y = SY + 22 + li * RH, first = Math.min(...layer.mods.map(m => m[3])), isNew = layer.mods.some(m => m[3] === n);
    t(layer.name, SX + 24, y + 46, 16, first > n ? c.faint : isNew ? c.accent : c.ink, 600);
    if (first > n) t(`S${String(first).padStart(2, "0")} 起`, SX + 24, y + 68, 13, c.faint);
    if (li) a.push(`<line x1="${SX + 16}" y1="${y - 6}" x2="${SX + SW - 16}" y2="${y - 6}" stroke="${c.line}" stroke-width="1"/>`);
    layer.mods.forEach(([id, name, desc, s, col], mi) => {
      const x = SX + LW + (col ?? mi) * (bw + gap), h = 84;
      pos[id] = { x, y, w: bw, h };
      if (s > n) { box(x, y, bw, h, "none", c.faint, "5 5"); t(name, x + 16, y + 36, 16, c.faint, 500); t(`S${String(s).padStart(2, "0")}`, x + 16, y + 60, 13, c.faint); return; }
      box(x, y, bw, h, s === n ? c.accentBg : c.card, s === n ? c.accent : c.line);
      if (s === n) a.push(`<rect x="${x + 1}" y="${y + 14}" width="4" height="${h - 28}" rx="2" fill="${c.accent}"/>`);
      t(name, x + 16, y + 36, 17, c.ink, 600); t(desc, x + 16, y + 62, 14, c.muted);
    });
  });

  // Codex：s00 是一轮一个进程的 codex exec，s01 起是常驻的 App Server。
  const CX = 1230, CY = 300, CW = 200, CH = 280;
  pos.codex = { x: CX, y: CY, w: CW, h: CH };
  box(CX, CY, CW, CH, c.greenBg, c.greenLine, "", 14);
  t(n ? "Codex" : "Codex CLI", CX + 20, CY + 40, 20, c.green, 700); t(n ? "App Server" : "codex exec · 一轮一进程", CX + 20, CY + 64, 15, c.green);
  (n ? ["执行循环", "原生 Skills", "原生历史"] : ["执行循环", "工具与沙箱", "本地会话"])
    .forEach((s, i) => { box(CX + 20, CY + 90 + i * 58, CW - 40, 44, c.card, c.greenLine, "", 8); t(s, CX + CW / 2, CY + 118 + i * 58, 15, c.ink, 500, "middle"); });

  const MY = n >= 7 ? 648 : 380;
  box(1460, MY, 92, 120, c.card, c.line); t("模型", 1506, MY + 52, 19, c.ink, 600, "middle"); t(n >= 7 ? "各家模型" : "理解与决策", 1506, MY + 80, 13, c.muted, 400, "middle");

  arrow(`M168,382 L${SX - 4},382`, c.ink);
  arrow(`M${SX + SW},${CY + 40} L${CX - 4},${CY + 40}`, c.ink); t(n ? "JSON-RPC" : "子进程", (SX + SW + CX) / 2, CY + 28, 13, c.muted, 500, "middle");
  if (n >= 3) { arrow(`M${CX - 2},${CY + CH - 40} L${SX + SW + 4},${CY + CH - 40}`, c.green, "6 5"); t("工具回调", (SX + SW + CX) / 2, CY + CH - 52, 13, c.green, 500, "middle"); }
  if (n >= 7) {
    // 模型请求不再直连：Codex → 网关 → 各家模型。
    const gy = pos.router.y, gx = pos.router.x + pos.router.w;
    arrow(`M${CX + 60},${CY + CH} L${CX + 60},${gy + 26} L${gx + 4},${gy + 26}`, c.green); t("模型请求", CX + 70, CY + CH + 40, 13, c.green, 500);
    arrow(`M${gx},${gy + 60} L1456,${gy + 60}`, c.ink);
  } else arrow(`M${CX + CW},${MY + 60} L1456,${MY + 60}`, c.green);

  for (const [id, ks] of num) { const p = pos[id]; ks.forEach((k, i) => badge(String(k), p.x + p.w - 6 - (ks.length - 1 - i) * 30, p.y - 2)); }

  const BY = SY + 24 + L.length * RH + 40, sw = (W - 96 - 5 * 20) / 6;
  t("一次请求怎么走", 48, BY, 17, c.ink, 700);
  st.path.forEach(([id, text], i) => {
    const x = 48 + i * (sw + 20), y = BY + 16, codex = id === "codex";
    box(x, y, sw, 58, codex ? c.greenBg : c.card, codex ? c.greenLine : c.line, "", 10);
    badge(String(i + 1), x + 24, y + 29); t(text, x + 46, y + 35, 16, c.ink, 500);
    if (i < st.path.length - 1) arrow(`M${x + sw + 2},${y + 29} L${x + sw + 16},${y + 29}`, c.faint);
  });
  a.push("</g></svg>\n");
  return a.join("");
}

// 细节图：供 docs/design.md 深入阅读，按"分区 → 一行节点"排布，配色与总图一致。
// 节点类型：new 本阶段新增，old 沿用，codex Codex 原生，warn 需要注意的分支。
const details = {
  "s06-skill-workflow/images/skill-workflow.svg": {
    title: "S06 细节：一个任务怎么走完 Workflow", sub: "Skill 教方法，Workflow 管边界和终点；模型决定怎么做，权限和验收留在模型之外。",
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
  "s07-model-gateway/images/model-gateway.svg": {
    title: "S07 细节：模型网关的三层作用", sub: "各家服务商的密钥只交给网关；Codex 只拿网关访问密钥。",
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

const check = process.argv.includes("--check");
dirs.forEach((dir, n) => {
  const file = path.join(root, dir, "images/architecture.svg"), body = render(n);
  if (check) { if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) throw new Error(`${dir} 的架构图不是最新；请运行 node stages/build-architecture.mjs`); }
  else fs.writeFileSync(file, body);
});
for (const [rel, d] of Object.entries(details)) {
  const file = path.join(root, rel), body = renderDetail(d);
  if (check) { if (fs.readFileSync(file, "utf8") !== body) throw new Error(`${rel} 不是最新；请运行 node stages/build-architecture.mjs`); }
  else fs.writeFileSync(file, body);
}
console.log(check ? `${dirs.length} 张架构图和 ${Object.keys(details).length} 张细节图是最新的。` : `已生成 ${dirs.length} 张架构图和 ${Object.keys(details).length} 张细节图。`);
