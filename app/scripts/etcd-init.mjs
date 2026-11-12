import { clusterNodes } from '../server/modules/config/cluster.mjs';
import { Etcd3, Range, isRecoverableError } from 'etcd3';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export async function initializeEtcd(env = process.env, {
  createClient = options => new Etcd3(options), now = Date.now, wait = sleep,
} = {}) {
  const hosts = env.ETCD_ENDPOINT || 'http://etcd:2379';
  for (const name of ['ETCD_ROOT_PASSWORD', 'ETCD_HEALTH_PASSWORD', ...clusterNodes(env).map(id => id.slice(-1).toUpperCase()).map(n => `ETCD_NODE_${n}_PASSWORD`)]) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  const deadline = now() + 60_000;
  // Bound both RPCs and the password/token exchange by the same startup deadline.
  const options = { hosts, dialTimeout: 3000,
    defaultCallOptions: () => ({ deadline: Math.min(deadline, now() + 3000) }) };
  for (;;) {
    try { return await initializeOnce(env, options, createClient); }
    catch (error) {
      if (!isRecoverableError(error)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error('etcd initialization timed out after 60 seconds', { cause: error });
      await wait(Math.min(1000, remaining));
      if (now() >= deadline) throw new Error('etcd initialization timed out after 60 seconds', { cause: error });
    }
  }
}

async function initializeOnce(env, options, createClient) {
  const rootClient = () => createClient({ ...options, auth: {
    username: 'root', password: env.ETCD_ROOT_PASSWORD, callOptions: options.defaultCallOptions,
  } });
  let client = createClient(options);
  try {
    let users, enabled = false;
    try { users = await client.getUsers(); }
    catch (error) {
      if (isRecoverableError(error)) throw error;
      client.close();
      client = rootClient();
      users = await client.getUsers(); enabled = true;
    }
    if (!users.some(u => u.name === 'root')) await client.user('root').create(env.ETCD_ROOT_PASSWORD);
    if (!(await client.getRoles()).some(role => role.name === 'root')) await client.role('root').create();
    if (!(await client.user('root').roles()).some(role => role.name === 'root')) await client.user('root').addRole('root');
    if (!enabled) await client.auth.authEnable();
    client.close();
    client = rootClient();
    const accounts = [
      { name: 'health', password: env.ETCD_HEALTH_PASSWORD, permission: { permission: 'Read', key: 'health' } },
      ...clusterNodes(env).map(id => id.slice(-1)).map(suffix => ({
        name: `node-${suffix}`, password: env[`ETCD_NODE_${suffix.toUpperCase()}_PASSWORD`],
        permission: { permission: 'Readwrite', range: Range.prefix('/codex/') },
      })),
    ];
    for (const { name, password, permission } of accounts) {
      const role = client.role(name), user = client.user(name);
      if (!(await client.getRoles()).some(r => r.name === name)) await role.create();
      for (const previous of await role.permissions()) await role.revoke(previous);
      await role.grant(permission);
      if (!(await client.getUsers()).some(u => u.name === name)) await user.create(password);
      else await user.setPassword(password);
      const roles = await user.roles();
      for (const previous of roles) if (previous.name !== name) await user.removeRole(previous);
      if (!roles.some(previous => previous.name === name)) await user.addRole(role);
    }
  } finally { client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await initializeEtcd(); console.log('etcd auth enabled; node roles restricted to /codex/; health can only read key health.'); }
  catch { console.error('etcd authentication initialization failed. Check connectivity and server .env.'); process.exitCode = 1; }
}
