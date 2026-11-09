import { nodeKeyHash } from '../../server/modules/sharding/routing.mjs';
const keys = Object.fromEntries(['a','b','c'].map(s => ['node-' + s, 'test-only-node-' + s + '-independent-secret-123456789']));
export const testKeyHashes = Object.fromEntries(Object.entries(keys).map(([node, key]) => [node, nodeKeyHash(key)]));
export const nodeAuth = nodeId => ({ nodeId, key: keys[nodeId], keyHashes: testKeyHashes });
export const authHeaders = nodeId => ({ 'x-node-id': nodeId, 'x-node-key': keys[nodeId] });
