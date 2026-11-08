import fs from 'node:fs';
export const registeredStages=JSON.parse(fs.readFileSync(new URL('../../../stages/changes.json',import.meta.url),'utf8')).stages;
export const stageIds=registeredStages.map(stage=>stage.id);
// 阶段数从登记表取得；中文标签只负责格式化，不写死数量。
const digits='零一二三四五六七八九';
const n=stageIds.length;
export const stageCountLabel=(n<10?digits[n]:`${n<20?'':digits[Math.floor(n/10)]}十${n%10?digits[n%10]:''}`)+'个阶段';
