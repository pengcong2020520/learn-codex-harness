import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const lessons = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const [id = 'list', ...flags] = process.argv.slice(2);
function fail(message) { console.error(message); process.exit(2); }
if (id === 'list') {
  if (flags.length) fail('list 不接受其他参数。');
  for (const item of lessons) console.log(`${item.id} · ${item.title} · ${item.mode === 'offline' ? '离线断言' : '集成门禁（默认未运行）'}`);
  console.log('运行：npm run lesson -- <id>。每课会先解释问题、命令、观察与边界。');
} else {
  const item = lessons.find(value => value.id === id);
  if (!item) fail('未知课时 ID；请运行 npm run lesson -- list。');
  if (flags.length > 1 || flags.some(flag => flag !== item.requiredFlag)) fail('本课参数只允许：' + (item.requiredFlag || '无；不接受任意命令或参数'));
  const quote = value => /^[a-zA-Z0-9_./=:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  console.log(`\n${item.id} · ${item.title}\n学习问题：${item.question}`);
  console.log('实际校验命令（在本 Demo 目录）：node ' + item.args.map(quote).join(' '));
  console.log('预期观察（以下是待验证断言，不是运行结果）：');
  item.observations.forEach(value => console.log('  - ' + value));
  console.log('为何如此：' + item.why + '\n边界：' + item.boundary);
  if (item.mode === 'integration' && !flags.includes(item.requiredFlag)) {
    console.log('前置条件：' + item.prerequisites);
    console.log('状态：未运行（NOT RUN）；未启动服务，不能计为通过。');
    console.log('显式运行：' + item.integrationCommand);
  } else {
    // Allow only basic OS paths into fixtures; never inherit provider keys, URLs or NODE_OPTIONS.
    const env = { PATH: process.env.PATH || '', LANG: 'C.UTF-8' };
    for (const key of ['TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    console.log('开始执行真实测试；只有下方 Node 测试报告才代表运行结果。');
    const result = spawnSync(process.execPath, item.args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      ...(item.mode === 'offline' ? { timeout: 60000 } : {}) });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    const pass = [...(result.stdout || '').matchAll(/^(?:#|ℹ)\s+pass (\d+)$/gm)].at(-1);
    if (result.error || result.status !== 0 || !pass || Number(pass[1]) === 0) {
      console.error('状态：校验失败或没有实际通过的断言。' + (result.error?.message || ''));
      process.exitCode = result.status || 1;
    } else console.log(`状态：测试进程成功结束；实际通过 ${pass[1]} 项。跳过项不计为通过，证据范围以上述边界为限。`);
  }
}
