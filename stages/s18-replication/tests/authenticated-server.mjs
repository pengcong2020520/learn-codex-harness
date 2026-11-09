import fs from 'node:fs';
import path from 'node:path';
import { startAgentServer as start } from '../server/main.mjs';
import { openDatabase, identity } from '../server/modules/data/database.mjs';
import { AccountStore } from '../server/modules/accounts/store.mjs';
import { initializeAccounts } from '../server/modules/accounts/admin.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { AgentDefinition } from '../server/modules/agents/index.mjs';
import { saveCredentials } from '../client/modules/connection/credentials.mjs';
import { asUser } from './helpers.mjs';

// Test-only compatibility for inherited single-user regression fixtures.
export async function startAgentServer(options) {
  const { config } = options;
  let ownerId;
  if (!options.dataFactory) {
    const pool = await openDatabase(config.data.databaseUrl);
    try {
      const scope = identity(config.root); ownerId = scope.ownerId;
      const store = new AccountStore(pool, scope.instanceId);
      if (!(await store.byUsername('fixture-admin'))) {
        const agent = new AgentDefinition(config.root, config.agentFile);
        await initializeAccounts(store, { ownerId, username: 'fixture-admin', password: 'fixture-password', workspace: agent.workspacePath });
        // Custom example roots (not the four legacy folders) are fixture setup, not product migration.
        const target = path.join(agent.workspacePath, 'users', ownerId);
        for (const name of fs.readdirSync(agent.workspacePath)) if (name !== 'users' && !name.startsWith('.')) {
          const source = path.join(agent.workspacePath, name), dest = path.join(target, name);
          if (fs.statSync(source).isDirectory() && !fs.existsSync(dest)) fs.renameSync(source, dest);
        }
      }
    } finally { await pool.end(); }
  }
  const app = await start(options);
  if (!options.validationOnly) {
    const username = options.dataFactory ? 'alice' : 'fixture-admin';
    const response = await fetch(app.url + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'fixture-password' }) });
    if (!response.ok) throw new Error('Test fixture login failed');
    const login = await response.json(); ownerId = login.user.id;
    app.token = login.token; // Test-only caller credential, never returned by production startup.
    saveCredentials(config.root, { url: app.url, token: login.token });
  }
  app.ownerId = ownerId;
  const permissionHub = app.permissionHub || app.gate?.permissionHub;
  // In-memory legacy fixtures have no Hub and retain their synchronous methods.
  // Real-PG calls get a fresh snapshot on every entry, including after grant/revoke.
  const enter = operation => permissionHub ? asUser(permissionHub, ownerId, operation) : runOwner(ownerId, operation);
  const scoped = service => service && new Proxy(service, { get(target, key) {
    return runOwner(ownerId, () => {
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? (...args) => enter(() => value.apply(target, args)) : value;
    });
  } });
  app.data = { ...app.data, repository: scoped(app.data.repository), jobs: scoped(app.data.jobs) };
  for (const name of ['sessions', 'messages', 'resources', 'knowledge', 'usage']) app[name] = scoped(app[name]);
  if (app.gate) {
    const operator = app.gate.operator.bind(app.gate);
    app.gate.operator = id => operator(id || ownerId);
  }
  return app;
}
