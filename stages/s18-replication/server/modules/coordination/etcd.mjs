// Only Namespace adaptation: Election, Campaign, Lease and all wire operations are etcd3.
// Pinned etcd3 1.1.2: Campaign calls namespace.lease -> grant -> put.
// Campaign error/resign revokes this shared lease; automatic rejoin obtains a fresh one.
import { normalizePrefix, clusterKey } from './keys.mjs';

export async function connectEtcd(hosts, auth, { prefix, rpcTimeout = 3000 } = {}) {
  prefix = normalizePrefix(prefix);
  const { Etcd3, Election } = await import('etcd3');
  // Bound unary RPCs and authentication, not the long-lived Watch/KeepAlive streams.
  const callOptions = context => context?.isStream ? {} : { deadline: Date.now() + rpcTimeout };
  const client = new Etcd3({ hosts, dialTimeout: rpcTimeout, defaultCallOptions: callOptions,
    ...(auth ? { auth: { ...auth, callOptions } } : {}) });
  client.keyPrefix = prefix;
  return { client, electionFactory: lease => sharedLeaseElection(client, lease, Election) };
}
export function sharedLeaseElection(client, lease, Election) {
  const namespace = client.namespace(clusterKey(client, 'controller/'));
  const scoped = new Proxy(namespace, {
    get(target, key) {
      if (key === 'lease') return () => lease;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Election({ namespace: () => scoped }, clusterKey(client, 'controller'), 10);
}
