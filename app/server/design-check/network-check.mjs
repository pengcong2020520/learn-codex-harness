// 仅供 Docker 验收：直接运行 Chromium，独立于 layout-check 的 CDP 请求拦截。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromeArgs } from './worker.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'design-network-'));
try {
  const file = path.join(directory, 'probe.html');
  // no-cors 下收到任意响应都算联网成功，不能把跨域读取失败误认成网络隔离。
  fs.writeFileSync(file, `<html><body id="result">等待检查</body><script>
    Promise.all(['https://example.com/', 'http://93.184.216.34/', 'http://node-a:4340/health'].map(async url => {
      try { await fetch(url, {mode:'no-cors'}); return '可访问'; } catch { return '已阻断'; }
    })).then(values => document.getElementById('result').textContent = values.join(','));
  </script></html>`);
  const { stdout } = await promisify(execFile)('/usr/bin/chromium', [
    '--headless=new', '--disable-gpu', '--disable-background-networking', ...chromeArgs,
    `--user-data-dir=${path.join(directory, 'profile')}`, '--dump-dom', '--virtual-time-budget=3000', pathToFileURL(file).href,
  ], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  assert.match(stdout, /<body id="result">已阻断,已阻断,已阻断<\/body>/);
  process.stdout.write('Chromium 网络验收通过：域名、直接 IP 和内部节点均不可访问。\n');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
