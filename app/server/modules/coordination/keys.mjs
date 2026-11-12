export const DEFAULT_PREFIX = '/codex/';

export function normalizePrefix(prefix = DEFAULT_PREFIX) {
  if (typeof prefix !== 'string' || !/^\/(?:[^/\s]+\/)+$/.test(prefix)) {
    throw new TypeError('ETCD_PREFIX must be an absolute, non-root prefix ending in /');
  }
  return prefix;
}

export const clusterKey = (client, suffix) => (client?.keyPrefix ?? DEFAULT_PREFIX) + suffix;
