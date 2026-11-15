import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../shared/errors.mjs';

export const nodeKeyHash = key => createHash('sha256').update(key).digest('hex');
export const nodeHeaders = runtime => ({ 'x-node-id': runtime.nodeId, 'x-node-key': runtime.key });
export function authenticateNode(headers, keyHashes, nodes = Object.keys(keyHashes || {})) {
  const nodeId = headers['x-node-id'], key = headers['x-node-key'];
  const expected = keyHashes?.[nodeId];
  if (!nodes.includes(nodeId) || typeof key !== 'string' || key.length < 24 ||
      !/^[a-f0-9]{64}$/.test(expected || '') || !timingSafeEqual(Buffer.from(nodeKeyHash(key)), Buffer.from(expected)))
    throw new AppError('节点认证失败。', 403, 'NODE_AUTH');
  return nodeId;
}
