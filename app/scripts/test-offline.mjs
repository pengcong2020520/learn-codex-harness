import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const ports = new Set(['http-cli.test.mjs', 'gateway-check.test.mjs', 'media-http.test.mjs', 'tool-loading.test.mjs']);
const onlyPorts = process.argv.includes('--ports');
const files = fs.readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.mjs') && ports.has(name) === onlyPorts && name !== 'streaming.test.mjs').map(name => `tests/${name}`);
if (onlyPorts) files.push('tests/sharding-http.integration.mjs', 'tests/eval-role-score-http.integration.mjs');
if (!onlyPorts) files.unshift('05-app-server.test.mjs');
const run = args => {
  const result = spawnSync(process.execPath, ['--test', ...args], { cwd: new URL('../', import.meta.url), stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status || 1;
};
run(files);
run([onlyPorts ? '--test-name-pattern=^(SSE：|CLI 订阅：)' : '--test-skip-pattern=^(SSE：|CLI 订阅：)', 'tests/streaming.test.mjs']);
