// 学习路线图：根 README 顶部那张图。按"跑起来 → 变成服务 → 装配 Agent → 上生产 → 走向生产"分组，每张卡片一个阶段。
// 运行：node stages/build-roadmap.mjs 生成 docs/images/learning-roadmap.svg；加 --check 只检查是否最新。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "docs/images/learning-roadmap.svg");

const phases = [
  { name: "跑起来", sub: "先让 Codex 干活", fill: "#EAF2FB", line: "#4A7BB7", ink: "#24507F", stages: [
    ["s00", "先体验", "用 SDK 交给 Codex 一个任务"], ["s01", "单轮问答", "接上模型，直接说 App Server 协议"], ["s02", "多轮会话", "同一个 Thread 接着聊"]] },
  { name: "变成服务", sub: "客户端随时来去", fill: "#EAF5EE", line: "#3E8A5E", ink: "#24603D", stages: [
    ["s03", "服务化", "服务端常驻，关掉客户端照样跑完"], ["s04", "事件与消息", "服务端排队，状态经 SSE 推送"]] },
  { name: "装配 Agent", sub: "它是谁、能做什么", fill: "#FFF3EC", line: "#D9622B", ink: "#9A3F14", stages: [
    ["s05", "Agent 装配", "一份 JSON 决定角色与 Skills"], ["s06", "工具", "白名单、资料边界、MCP 回调"], ["s07", "记忆", "Codex 提炼，服务端管控"]] },
  { name: "上生产", sub: "靠得住、守得住", fill: "#F3EEF8", line: "#7A54A8", ink: "#4F2E7A", stages: [
    ["s08", "数据层", "PostgreSQL 记事实，Redis 唤醒"], ["s09", "知识层", "可信门禁，Wiki / RAG"], ["s10", "Skill 与 Workflow", "可以提议，不能自批"], ["s11", "模型网关", "统一协议、多模型、管住花费"]] },
  { name: "走向生产", sub: "从部署到多主机", fill: "#F4F5F6", line: "#B8C0C6", ink: "#6B7780", stages: [
    ["s12", "上云部署", "一台没人看着的服务器，也能自己起来、自己恢复", "已完成"],
    ["s13", "账号与认证", "每个用户登录自己的账号，会话和任务都有归属", "规划中"],
    ["s14", "用户隔离", "每个用户一个独立的运行环境，互不可见", "规划中"],
    ["s15", "权限与资源 Hub", "角色、权益与资源范围：知识库、工具、Skill、Agent 谁能用、谁能改", "规划中"],
    ["s16", "多主机调度", "任务分到多台机器，坏了一台有人接手", "规划中"]] },
];

const esc = s => String(s).replace(/[&<>"]/g, v => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[v]));

export function render() {
  const W = 1600, LX = 48, LW = 196, CX = 270, GAP = 28, TOP = 150;
  // 每行最多四张；六张时分为两行三张，宽度按当行数量计算。
  let nextY = TOP;
  const layouts = phases.map(p => {
    const columns = p.stages.length > 4 ? 3 : p.stages.length;
    const rows = Array.from({ length: Math.ceil(p.stages.length / columns) }, (_, i) => p.stages.slice(i * columns, (i + 1) * columns));
    const ch = p.stages.some(stage => stage[3]) ? 138 : 96, bh = ch + 36;
    const layout = { y: nextY, ch, bh, rows, height: rows.length * (bh + 24) - 24 };
    nextY += layout.height + 24;
    return layout;
  });
  const cardWidth = count => (W - LX - CX - GAP * (count - 1)) / count;
  // 按保守字宽换行：汉字及全角标点一字宽，ASCII 取 0.65 字宽。
  const wrap = (text, width, size) => {
    const lines = []; let line = "", used = 0;
    for (const char of text.match(/[A-Za-z0-9]+|[^A-Za-z0-9]/gu) ?? []) {
      const advance = [...char].reduce((sum, c) => sum + size * (c.codePointAt(0) <= 0x7f ? 0.65 : 1), 0);
      if (used + advance > width && line) { lines.push(line); line = ""; used = 0; }
      line += char; used += advance;
    }
    if (line) lines.push(line);
    return lines;
  };
  const a = [];
  const t = (s, x, y, size, color, weight = 400, anchor = "start") => a.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`);
  const rect = (x, y, w, h, fill, stroke, r = 14, dash = "") => a.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
  const arrow = (d, color, dash = "") => a.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2"${dash ? ` stroke-dasharray="${dash}"` : ""} marker-end="url(#arrow-${color.slice(1)})"/>`);
  const colors = [...new Set(phases.map(p => p.line))];

  t("学习路线：亲手做一个云端 Agent", LX, 70, 32, "#1F2933", 700);
  t("每个阶段只多一个单元，都是可以独立运行和测试的真实代码；从 Codex 现成的 harness 出发，不自造 agent loop。", LX, 108, 18, "#6B7780");

  phases.forEach((p, pi) => {
    const layout = layouts[pi], { y, ch, bh, rows, height } = layout;
    const labelY = y + (height - 132) / 2;
    rect(LX, labelY, LW, 132, p.fill, p.line, 16);
    a.push(`<rect x="${LX}" y="${labelY + 18}" width="5" height="96" rx="2.5" fill="${p.line}"/>`);
    t(`阶段 ${pi + 1}`, LX + 24, labelY + 42, 14, p.ink, 600);
    t(p.name, LX + 24, labelY + 74, 24, p.ink, 700);
    if (p.sub) t(p.sub, LX + 24, labelY + 102, 14, "#6B7780");

    rows.forEach((row, ri) => {
      const cw = cardWidth(row.length), rowY = y + ri * (bh + 24), cy = rowY + 18;
      row.forEach(([id, title, desc, status], si) => {
        const x = CX + si * (cw + GAP), planned = status === "规划中";
        const line = status === "开发中" || status === "已完成" ? "#4A7BB7" : p.line;
        rect(x, cy, cw, ch, planned ? "#FBFBF9" : "#FFFFFF", line, 14, planned ? "6 5" : "");
        rect(x + 18, cy + 18, 48, 26, planned ? "#E3E7EA" : line, "none", 8);
        t(id, x + 42, cy + 36, 15, planned ? "#6B7780" : "#FFFFFF", 700, "middle");
        if (status) {
          rect(x + cw - 90, cy + 18, 72, 26, planned ? "#E3E7EA" : "#EAF2FB", "none", 8);
          t(status, x + cw - 54, cy + 36, 14, planned ? "#6B7780" : "#24507F", 600, "middle");
        }
        t(title, x + (status ? 18 : 78), cy + (status ? 68 : 37), 19, planned ? "#6B7780" : "#1F2933", 700);
        wrap(desc, cw - 36, 15).forEach((text, li) => t(text, x + 18, cy + (status ? 96 : 74) + li * 22, 15, "#6B7780"));
        if (si < row.length - 1) arrow(`M${x + cw + 4},${cy + ch / 2} L${x + cw + GAP - 6},${cy + ch / 2}`, p.line, planned ? "5 4" : "");
      });
      // 换行或换组：从末张卡片下方折回下一行第一张，端点按各行宽度计算。
      const next = ri + 1 < rows.length ? { layout, ri: ri + 1 } : pi + 1 < layouts.length ? { layout: layouts[pi + 1], ri: 0 } : null;
      if (next) {
        const last = CX + (row.length - 1) * (cw + GAP) + cw / 2;
        const first = CX + cardWidth(next.layout.rows[next.ri].length) / 2;
        const y1 = cy + ch + 4, mid = rowY + bh + 12;
        const y2 = next.layout.y + next.ri * (next.layout.bh + 24) + 12;
        const future = next.layout === layouts.at(-1);
        arrow(`M${last},${y1} L${last},${mid} L${first},${mid} L${first},${y2}`, future ? "#B8C0C6" : "#9AA5B1", future ? "5 4" : "");
      }
    });
  });

  // 终点：完整项目
  const H = nextY + 56;
  t("学完 s11，就是仓库里的 app/：在它之上做成 Docker 部署、Web 工作台和互动课程。", LX, H - 36, 16, "#6B7780");

  const defs = `<defs>${[...new Set([...colors, "#9AA5B1"])].map(c => `<marker id="arrow-${c.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join("")}</defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc"><title id="title">学习路线：亲手做一个云端 Agent</title><desc id="desc">s00 到 s11 分四组：跑起来、变成服务、装配 Agent、上生产；s12 到 s17 为第五组：走向生产，s12 开发中，s13 到 s17 规划中。</desc>${defs}<g font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"><rect width="${W}" height="${H}" fill="#FBFBF9"/>${a.join("")}</g></svg>\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = render();
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== body) throw new Error("docs/images/learning-roadmap.svg 不是最新；请运行 node stages/build-roadmap.mjs");
    console.log("学习路线图是最新的。");
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    console.log("已生成 docs/images/learning-roadmap.svg。");
  }
}
