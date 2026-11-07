// This worktree has no stages/build-roadmap.mjs. Keep the course roadmap derived
// from the same architecture data without modifying any stage sources.
import {dirs, stages} from '../../stages/build-architecture.mjs';
import {escapeHtml as esc} from './course-data.mjs';

export function renderRoadmap() {
  const width = 1440, columns = 3, rowHeight = 132, height = 90 + Math.ceil(dirs.length / columns) * rowHeight;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">学习路线图</title><desc id="desc">按从左到右、从上到下的顺序，从 SDK 体验逐步搭建云端 Agent。</desc>
<rect width="${width}" height="${height}" rx="20" fill="#FBFBF9"/>
<g font-family="PingFang SC,Microsoft YaHei,system-ui,sans-serif"><text x="30" y="42" fill="#1F2933" font-size="23" font-weight="700">从第一次调用，到云端 Agent</text>
${dirs.map((dir, i) => {
  const id = dir.slice(0,3), stage = stages[Number(id.slice(1))], x = 30 + i % columns * 470, y = 66 + Math.floor(i / columns) * rowHeight;
  const title = Array.from(stage.title), lines = [title.slice(0,21).join(''), title.slice(21).join('')].filter(Boolean);
  return `<g><rect x="${x}" y="${y}" width="440" height="110" rx="12" fill="#fff" stroke="#E3E7EA"/><text x="${x+18}" y="${y+29}" fill="#D9622B" font-size="17" font-weight="700">${esc(id)}</text>${lines.map((line,j)=>`<text x="${x+18}" y="${y+59+j*26}" fill="#1F2933" font-size="18">${esc(line)}</text>`).join('')}</g>`;
}).join('\n')}
</g></svg>\n`;
}
