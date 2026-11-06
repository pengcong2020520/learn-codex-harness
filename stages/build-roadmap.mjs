// 学习路线图：根 README 顶部那张图。按"跑起来 → 变成服务 → 装配 Agent → 上生产 → 规划中"分组，每张卡片一个阶段。
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
    ["s08", "数据层", "PostgreSQL 记事实，Redis 只叫醒"], ["s09", "知识层", "可信门禁，Wiki / RAG"], ["s10", "Skill 与 Workflow", "可以提议，不能自批"], ["s11", "模型网关", "统一协议、多模型、管住花费"]] },
  { name: "规划中", sub: "", fill: "#F4F5F6", line: "#B8C0C6", ink: "#6B7780", planned: true, stages: [
    ["s12", "上云部署", "Docker、服务器、开机自启"], ["s13", "多用户", "认证、隔离、配额"], ["s14", "多 Agent 协作", "分工协作，各守权限边界"], ["s15", "多主机调度", "节点、租约、故障接管"]] },
];

const esc = s => String(s).replace(/[&<>"]/g, v => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[v]));

export function render() {
  const W = 1600, LX = 48, LW = 196, CX = 270, CW = 300, CH = 96, GAP = 28, BH = 132, TOP = 150;
  const a = [];
  const t = (s, x, y, size, color, weight = 400, anchor = "start") => a.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`);
  const rect = (x, y, w, h, fill, stroke, r = 14, dash = "") => a.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
  const arrow = (d, color, dash = "") => a.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2"${dash ? ` stroke-dasharray="${dash}"` : ""} marker-end="url(#arrow-${color.slice(1)})"/>`);
  const colors = [...new Set(phases.map(p => p.line))];

  t("学习路线：亲手做一个云端 Agent", LX, 70, 32, "#1F2933", 700);
  t("每个阶段只多一个单元，都是可以独立运行和测试的真实代码；从 Codex 现成的 harness 出发，不自造 agent loop。", LX, 108, 18, "#6B7780");

  phases.forEach((p, pi) => {
    const y = TOP + pi * (BH + 24);
    // 阶段标签
    rect(LX, y, LW, BH, p.fill, p.line, 16, p.planned ? "6 5" : "");
    a.push(`<rect x="${LX}" y="${y + 18}" width="5" height="${BH - 36}" rx="2.5" fill="${p.line}"/>`);
    if (!p.planned) t(`阶段 ${pi + 1}`, LX + 24, y + 42, 14, p.ink, 600);
    t(p.name, LX + 24, y + 74, 24, p.ink, 700);
    if (p.sub) t(p.sub, LX + 24, y + 102, 14, "#6B7780");
    // 阶段卡片
    p.stages.forEach(([id, title, desc], si) => {
      const x = CX + si * (CW + GAP), cy = y + (BH - CH) / 2;
      rect(x, cy, CW, CH, p.planned ? "#FBFBF9" : "#FFFFFF", p.line, 14, p.planned ? "6 5" : "");
      rect(x + 18, cy + 18, 48, 26, p.planned ? "#E3E7EA" : p.line, "none", 8);
      t(id, x + 42, cy + 36, 15, p.planned ? "#6B7780" : "#FFFFFF", 700, "middle");
      t(title, x + 78, cy + 37, 19, p.planned ? "#6B7780" : "#1F2933", 700);
      if (desc) t(desc, x + 18, cy + 74, 15, "#6B7780");
      if (si < p.stages.length - 1) arrow(`M${x + CW + 4},${cy + CH / 2} L${x + CW + GAP - 6},${cy + CH / 2}`, p.line, p.planned ? "5 4" : "");
    });
    // 换到下一组：从本组最后一张卡片下方折回下一组第一张卡片
    if (pi < phases.length - 1) {
      const last = CX + (p.stages.length - 1) * (CW + GAP) + CW / 2, first = CX + CW / 2;
      const y1 = y + (BH + CH) / 2 + 4, mid = y + BH + 12, y2 = y + BH + 24 + (BH - CH) / 2 - 6;
      const next = phases[pi + 1];
      arrow(`M${last},${y1} L${last},${mid} L${first},${mid} L${first},${y2}`, next.planned ? "#B8C0C6" : "#9AA5B1", next.planned ? "5 4" : "");
    }
  });

  // 终点：完整项目
  const H = TOP + phases.length * (BH + 24) + 56;
  t("学完 s11，就是仓库里的 app/：在它之上做成 Docker 部署、Web 工作台和互动课程。", LX, H - 36, 16, "#6B7780");

  const defs = `<defs>${[...colors, "#9AA5B1", "#B8C0C6"].map(c => `<marker id="arrow-${c.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join("")}</defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc"><title id="title">学习路线：亲手做一个云端 Agent</title><desc id="desc">s00 到 s11 分四组：跑起来、变成服务、装配 Agent、上生产；s12 到 s15 规划中。</desc>${defs}<g font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"><rect width="${W}" height="${H}" fill="#FBFBF9"/>${a.join("")}</g></svg>\n`;
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
