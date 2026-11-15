// Docker 验收用短取消期限验证清理路径；生产请求仍固定为 60 秒。
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { runCheck } from './service.mjs';

const directories = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('design-check-')).sort();
const before = directories();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('检查超时')), 2000);
try {
  await assert.rejects(runCheck({ html: '<html><script>while(true){}</script></html>', viewports: [{ width: 800, height: 600 }] }, controller.signal), /检查超时/);
} finally { clearTimeout(timer); }
assert.deepEqual(directories(), before, '超时后临时目录未清理');
for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
  let command;
  try { command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
  assert.ok(!command.includes('--user-data-dir=/tmp/design-check-'), '超时后存在残留 Chromium');
}
const html = '<html><style>html,body{margin:0;width:100%;height:100%;font:14px sans-serif}</style><section data-screen="web-home" data-state="default" data-group="main">正常页面</section><script id="design-outline" type="application/json">{"groups":[{"id":"main","screens":[{"id":"web-home","states":["default"]}]}]}</script></html>';
const report = await runCheck({ html, viewports: [{ width: 800, height: 600 }] }, AbortSignal.timeout(60000));
assert.equal(report.errors, 0);
assert.deepEqual(directories(), before);
process.stdout.write('Chromium 生命周期验收通过：取消后无残留进程和目录，后续检查成功。\n');
