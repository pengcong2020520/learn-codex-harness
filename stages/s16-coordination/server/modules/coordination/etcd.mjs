// Only Namespace adaptation: Election, Campaign, Lease and all wire operations are etcd3.
// Pinned etcd3 1.1.2: Campaign calls namespace.lease -> grant -> put.
// Campaign error/resign revokes this shared lease; automatic rejoin obtains a fresh one.
export async function connectEtcd(hosts, auth) {
  const { Etcd3, Election } = await import('etcd3');
  const client = new Etcd3({ hosts, ...(auth ? { auth } : {}) });
  return { client, electionFactory: lease => sharedLeaseElection(client, lease, Election) };
}
export function sharedLeaseElection(client, lease, Election) {
  const namespace = client.namespace('/codex/controller/');
  const scoped = new Proxy(namespace, {
    get(target, key) {
      if (key === 'lease') return () => lease;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Election({ namespace: () => scoped }, '/codex/controller', 10);
}
