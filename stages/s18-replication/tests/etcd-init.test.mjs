import test from 'node:test';
import assert from 'node:assert/strict';
import { Etcd3, GRPCUnavailableError, EtcdAuthenticationFailedError, EtcdPermissionDeniedError } from 'etcd3';
import { initializeEtcd } from '../scripts/etcd-init.mjs';

const env = {
  ETCD_ROOT_PASSWORD: 'test-root', ETCD_HEALTH_PASSWORD: 'test-health',
  ETCD_NODE_A_PASSWORD: 'test-a', ETCD_NODE_B_PASSWORD: 'test-b', ETCD_NODE_C_PASSWORD: 'test-c',
};

// Exercise the installed etcd3 user/role API without opening any sockets.
function fixture() {
  const users = new Map(), roles = new Map(), calls = [], clients = [];
  const state = { enabled: false, failures: 0, clock: 0 };
  const options = {
    now: () => state.clock,
    wait: async ms => { state.clock += ms; },
    createClient(options) {
      const client = new Etcd3(options);
      const record = { options, closed: false };
      clients.push(record);
      const close = client.close.bind(client);
      client.close = () => { record.closed = true; close(); };
      client.mock({ exec: async (service, method, request) => {
        assert.equal(record.closed, false);
        calls.push({ method, request });
        if (state.failures-- > 0) throw new GRPCUnavailableError('connection refused');
        if (state.enabled) {
          if (!options.auth) throw new EtcdPermissionDeniedError('user name is empty');
          if (users.get(options.auth.username)?.password !== options.auth.password) throw new EtcdAuthenticationFailedError('bad credentials');
        }
        const user = users.get(request?.name ?? request?.user);
        switch (method) {
          case 'userList': return { users: [...users.keys()] };
          case 'roleList': return { roles: [...roles.keys()] };
          case 'userAdd':
            assert.ok(!user, 'must not recreate an existing user');
            users.set(request.name, { password: request.password, roles: new Set() }); break;
          case 'roleAdd':
            assert.ok(!roles.has(request.name), 'must not recreate an existing role');
            roles.set(request.name, []); break;
          case 'userGet': return { roles: [...user.roles] };
          case 'userGrantRole':
            assert.ok(!user.roles.has(request.role), 'must not regrant an existing role');
            user.roles.add(request.role); break;
          case 'userRevokeRole': user.roles.delete(request.role); break;
          case 'userChangePassword': user.password = request.password; break;
          case 'roleGet': return { perm: roles.get(request.role) };
          case 'roleGrantPermission': roles.get(request.name).push(request.perm); break;
          case 'roleRevokePermission':
            roles.set(request.role, roles.get(request.role).filter(p => !p.key.equals(request.key) || !p.range_end.equals(request.range_end))); break;
          case 'authEnable':
            assert.equal(state.enabled, false, 'must not re-enable authentication');
            assert.ok(users.get('root').roles.has('root'));
            state.enabled = true; break;
          default: assert.fail(`unexpected RPC ${service}.${method}`);
        }
        return {};
      } });
      return client;
    },
  };
  return { users, roles, calls, clients, state, options };
}

function assertHealth(f) {
  assert.deepEqual([...f.users.get('health').roles], ['health']);
  assert.equal(f.users.get('health').password, env.ETCD_HEALTH_PASSWORD);
  const permissions = f.roles.get('health');
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].permType, 'Read');
  assert.equal(permissions[0].key.toString(), 'health');
  assert.equal(permissions[0].range_end.length, 0, 'exact key, not a prefix or range');
  assert.ok(f.clients.every(c => c.closed), 'all clients must close');
}

test('etcd-init: fresh initialization and rerun preserve auth and exact health read permission', async () => {
  const f = fixture();
  await initializeEtcd(env, f.options);
  assert.equal(f.state.enabled, true);
  assertHealth(f);
  await initializeEtcd(env, f.options);
  assertHealth(f);
  assert.equal(f.calls.filter(c => c.method === 'authEnable').length, 1);
  for (const name of ['node-a', 'node-b', 'node-c']) {
    assert.deepEqual([...f.users.get(name).roles], [name]);
    assert.equal(f.roles.get(name)[0].permType, 'Readwrite');
    assert.equal(f.roles.get(name)[0].key.toString(), '/codex/');
    assert.equal(f.roles.get(name)[0].range_end.toString(), '/codex0');
  }
});

test('etcd-init: authenticated old volume gets health account and existing excessive privileges are removed', async () => {
  const f = fixture();
  await initializeEtcd(env, f.options);
  f.users.delete('health'); f.roles.delete('health'); f.calls.length = 0;
  await initializeEtcd(env, f.options);
  assertHealth(f);
  assert.ok(!f.calls.some(c => c.method === 'authEnable'));
  f.users.get('health').roles.add('root');
  f.users.get('health').password = 'old-health-password';
  f.roles.get('health').push({ permType: 'Readwrite', key: Buffer.from('/'), range_end: Buffer.from('0') });
  await initializeEtcd(env, f.options);
  assertHealth(f);
  assert.equal(f.users.get('root').password, env.ETCD_ROOT_PASSWORD);
});

test('etcd-init: retries connection failures, caps the startup window at 60 seconds and closes clients', async () => {
  const f = fixture(); f.state.failures = 2;
  await initializeEtcd(env, f.options);
  assert.equal(f.state.clock, 2000);
  assertHealth(f);
  const down = fixture(); down.state.failures = Infinity;
  await assert.rejects(initializeEtcd(env, down.options), /timed out after 60 seconds/);
  assert.equal(down.state.clock, 60_000);
  assert.equal(down.clients.length, 60);
  assert.ok(down.clients.every(c => c.closed));
  for (const { options } of down.clients) assert.ok(options.defaultCallOptions().deadline <= 60_000);
  for (const { options } of f.clients.filter(c => c.options.auth)) assert.equal(options.auth.callOptions, options.defaultCallOptions);
});

test('etcd-init: missing health password or incorrect root credentials fail without retrying', async () => {
  const f = fixture();
  await assert.rejects(initializeEtcd({ ...env, ETCD_HEALTH_PASSWORD: '' }, f.options), /Missing ETCD_HEALTH_PASSWORD/);
  assert.equal(f.clients.length, 0);
  await initializeEtcd(env, f.options);
  await assert.rejects(initializeEtcd({ ...env, ETCD_ROOT_PASSWORD: 'wrong' }, f.options), EtcdAuthenticationFailedError);
  assert.equal(f.state.clock, 0);
  assert.ok(f.clients.every(c => c.closed));
});
