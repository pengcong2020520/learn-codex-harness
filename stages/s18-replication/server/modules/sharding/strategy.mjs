import { createHash } from 'node:crypto';
export const SHARDS = ['0', '1', '2'];
export const SLOT_COUNT = 64;
export const defaultSlots = () => Object.fromEntries(Array.from({ length: SLOT_COUNT }, (_, n) => [n, SHARDS[n % 3]]));
export const slotOf = id => createHash('sha256').update(String(id)).digest().readUInt32BE(0) % SLOT_COUNT;
export const strategies = {
  slots: { shardOf: (userId, map) => map.slots[slotOf(userId)] },
  range: { shardOf(userId) {
    const prefix = String(userId).replaceAll('-', '').slice(0, 2);
    if (!/^[a-f0-9]{2}$/i.test(prefix)) throw new Error('范围策略需要十六进制用户 ID。');
    const n = parseInt(prefix, 16);
    return n < 0x55 ? '0' : n < 0xaa ? '1' : '2';
  } },
};
export function strategy(name = 'slots') {
  if (!strategies[name]) throw new Error('AGENT_SHARD_STRATEGY 必须为 slots 或 range。');
  return strategies[name];
}
