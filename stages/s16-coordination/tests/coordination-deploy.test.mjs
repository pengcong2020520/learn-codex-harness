import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
test('deployment: each runtime node has only its own database role; migration credentials only in one-shot', async () => {
  const calls = []; const pool = { query: async (...args) => { calls.push(args); return { rowCount: 0 }; } };
  await provisionNodeRoles(pool, { a: 'a'.repeat(24), b: 'b'.repeat(24), c: 'c'.repeat(24) });
  for (const node of ['a','b','c']) {
    assert.ok(calls.some(([sql]) => sql.includes(`CREATE ROLE agent_node_${node} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`)));
    assert.ok(calls.some(([sql]) => sql.includes(`REVOKE INSERT, UPDATE, DELETE ON agent_data.migrations FROM agent_node_${node}`)));
  }
  await assert.rejects(provisionNodeRoles(pool, { a: "';unsafe" }));
  const compose = read('compose.yaml').split('  node-a: &node')[1];
  assert.doesNotMatch(compose, /AGENT_DB_PASSWORD|OPENAI_API_KEY|ARK_API_KEY/);
  for (const suffix of ['a','b','c']) assert.ok(compose.includes(`postgresql://agent_node_${suffix}:`));
  assert.match(read('deploy/server-setup.sh'), /\.env:ro.*cluster-migrate.mjs/);
  assert.doesNotMatch(compose, /\.env:ro/);
});
test('deployment: local coordination hooks cover runtime result, files, dispatch and PG connections', () => {
  assert.match(read('server/modules/data/index.mjs'), /fencePool\(rawPool, config.generation\)/);
  assert.match(read('server/modules/runtimes/router.mjs'), /this.generation\?\.assert\(\)/);
  assert.match(read('server/main.mjs'), /assertCurrent:.*generation\?\.assert\(\)/);
  assert.match(read('server/main.mjs'), /externalHttp \?/);
  assert.match(read('server/modules/coordination/node.mjs'), /await coordination.confirm\(\)/);
  assert.match(read('server/modules/coordination/etcd.mjs'), /new Election/);
  assert.doesNotMatch(read('server/modules/coordination/etcd.mjs'), /grpc-js|\.proto|fetch\(/);
});
