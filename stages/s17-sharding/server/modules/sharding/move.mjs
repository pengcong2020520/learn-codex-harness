import { SHARDS } from './strategy.mjs';
// executeMove holds a per-user advisory lock; all durable transitions also hold cluster_term.
export async function moveUser({ userId, shardId, control, pause, drain, copy, resume }) {
  if (!SHARDS.includes(shardId)) throw new Error('分片必须是 0、1、2。');
  const term = control.coordination?.term();
  const op = await control.beginMove(userId, shardId);
  if (!op) return { unchanged: true };
  try {
    await pause(op.source_node, userId, op.id);
    await drain(op.source_node, userId, op.id);
    await control.advanceMove(op.id, 'paused', 'copying');
    await copy(op.source_node, op.target_node, userId, op.id);
    await control.advanceMove(op.id, 'copying', 'copied');
    await control.switchUser(userId, shardId, op.id);
    await resume(op.target_node, userId, op.id);
    await resume(op.source_node, userId, op.id);
    await control.finishMove(op);
    return { userId, from: op.from_shard, shardId, operationId: op.id };
  } catch (error) {
    // Never revive an old disk after an uncertain COMMIT or publish; retain both copies for recovery.
    await control.failMove(op.id, term).catch(() => { error.rollbackFailed = true; });
    throw error;
  }
}
