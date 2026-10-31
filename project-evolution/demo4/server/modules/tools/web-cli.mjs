// 固定命令入口：只允许 search/read，不执行模型提供的 Shell 字符串。
import { pathToFileURL } from "node:url";
import { searchWeb, readWebpage } from "./web.mjs";

export async function main(args = process.argv.slice(2)) {
  const [action, value, count] = args;
  try {
    let data;
    if (action === "search" && args.length <= 3) data = await searchWeb({ query: value, limit: count === undefined ? 5 : Number(count) });
    else if (action === "read" && args.length <= 3) data = await readWebpage({ url: value, max_chars: count === undefined ? 16000 : Number(count) });
    else throw new Error('用法：npm run tools -- search "搜索语句" [数量]；或 npm run tools -- read "https://文章地址" [字符数]');
    console.log(JSON.stringify({ ok: true, data }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
