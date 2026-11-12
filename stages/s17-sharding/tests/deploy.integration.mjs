// Explicit external acceptance: starts Docker services, never run in restricted sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function compose(args) {
  const r = spawnSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8' });
  // Do not print compose config or errors containing resolved secrets.
  assert.equal(r.status, 0, `docker compose ${args[0]} failed`);
  return r.stdout;
}
test('真实 Compose：八服务健康、故障就绪/存活分离、恢复与版本', async () => {
  compose(['up', '-d', '--wait']);
  const config = JSON.parse(compose(['config', '--format', 'json']));
  for (const [name, bytes] of Object.entries({ postgres: 256 * 1024 ** 2, redis: 128 * 1024 ** 2, gateway: 256 * 1024 ** 2, 'node-a': 768 * 1024 ** 2, 'node-b': 768 * 1024 ** 2, 'node-c': 768 * 1024 ** 2, etcd: 128 * 1024 ** 2, caddy: 64 * 1024 ** 2 })) {
    const service = config.services[name];
    assert.equal(Number(service.mem_limit), bytes); assert.equal(service.restart, 'unless-stopped');
    assert.equal(service.logging.options['max-size'], '10m'); assert.equal(service.logging.options['max-file'], '3');
    for (const port of service.ports || []) assert.equal(port.host_ip, '127.0.0.1');
  }
  const url = `http://127.0.0.1:${4335}`;
  const ready = await fetch(`${url}/ready`); assert.equal(ready.status, 200);
  const version = fs.existsSync(`${root}REVISION`) ? fs.readFileSync(`${root}REVISION`, 'utf8').trim() : 'dev';
  assert.equal((await ready.json()).version, version);
  try {
    compose(['stop', 'gateway']);
    assert.equal((await fetch(`${url}/ready`)).status, 503);
    for (const node of ['node-a', 'node-b', 'node-c']) {
      assert.equal(JSON.parse(compose(['exec', '-T', node, 'node', 'deploy/ready.mjs', '--alive'])).status, 'alive');
    }
  } finally { compose(['up', '-d', '--wait', 'gateway']); }
  // Caddy health state updates asynchronously after the dependency returns.
  for (let i = 0; i < 12; i++) {
    if ((await fetch(`${url}/ready`)).status === 200) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.fail('gateway 恢复后入口仍未就绪');
});
