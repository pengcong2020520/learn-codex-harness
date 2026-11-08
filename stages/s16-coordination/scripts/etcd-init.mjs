import { Etcd3, Range } from 'etcd3';
import { pathToFileURL } from 'node:url';

export async function initializeEtcd(env = process.env) {
  const hosts = env.ETCD_ENDPOINT || 'http://etcd:2379';
  for (const name of ['ETCD_ROOT_PASSWORD', ...['A', 'B', 'C'].map(n => `ETCD_NODE_${n}_PASSWORD`)]) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  let client = new Etcd3({ hosts });
  try {
    let users, enabled = false;
    try { users = await client.getUsers(); }
    catch {
      client.close();
      client = new Etcd3({ hosts, auth: { username: 'root', password: env.ETCD_ROOT_PASSWORD } });
      users = await client.getUsers(); enabled = true;
    }
    if (!users.some(u => u.name === 'root')) await client.user('root').create(env.ETCD_ROOT_PASSWORD);
    if (!(await client.getRoles()).some(role => role.name === 'root')) await client.role('root').create();
    await client.user('root').addRole('root');
    if (!enabled) await client.auth.authEnable();
    client.close();
    client = new Etcd3({ hosts, auth: { username: 'root', password: env.ETCD_ROOT_PASSWORD } });
    for (const suffix of ['a', 'b', 'c']) {
      const name = `node-${suffix}`, password = env[`ETCD_NODE_${suffix.toUpperCase()}_PASSWORD`];
      const role = client.role(name), user = client.user(name);
      if (!(await client.getRoles()).some(r => r.name === name)) await role.create();
      for (const permission of await role.permissions()) await role.revoke(permission);
      await role.grant({ permission: 'Readwrite', range: Range.prefix('/codex/') });
      if (!(await client.getUsers()).some(u => u.name === name)) await user.create(password);
      else await user.setPassword(password);
      for (const previous of await user.roles()) if (previous.name !== name) await user.removeRole(previous);
      await user.addRole(role);
    }
  } finally { client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await initializeEtcd(); console.log('etcd auth enabled; node roles restricted to /codex/.'); }
  catch { console.error('etcd authentication initialization failed. Check connectivity and server .env.'); process.exitCode = 1; }
}
