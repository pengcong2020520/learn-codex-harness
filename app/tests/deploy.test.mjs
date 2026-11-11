import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
test('本机 Docker 保留 Agent 与依赖，不启动课程或阶段演示', () => {
  const compose = read('compose.yaml');
  assert.match(compose, /^name: codex-harness-app$/m);
  assert.deepEqual([...compose.matchAll(/^  ([a-z]+):$/gm)].map(m => m[1]), ['postgres', 'redis', 'gateway', 'ollama', 'agent', 'chroma']);
  assert.doesNotMatch(compose, /14320|network_mode:|stages-data/);
  assert.match(compose, /\$\{AGENT_PORT:-4317\}:4317/);
  for (const name of ['postgres-data', 'redis-data', 'ollama-data', 'chroma-data']) assert.ok(compose.includes(`  ${name}:`));
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts.web, undefined);
  assert.equal(scripts['test:web'], undefined);
  assert.ok(!Object.keys(scripts).some(key => key.startsWith('course:')));
  assert.match(read('Dockerfile'), /USER node/);
  assert.match(read('Dockerfile'), /EXPOSE 4317\n/);
});
