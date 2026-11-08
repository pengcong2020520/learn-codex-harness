import { SHARDS } from './strategy.mjs';
import { unavailable } from './routing.mjs';
// The controller serializes moves with a PostgreSQL advisory lock. Source data is retained.
export async function moveUser({ userId, shardId, control, cache, pause, drain, copy, resume }) {
  if (!SHARDS.includes(shardId)) throw new Error('分片必须是 0、1、2。');
  const source = cache.routeOf(userId), target = cache.shards[shardId];
  if (!target?.primary) throw unavailable('目标分片无主节点。');
  if (source.shardId === shardId) {
    if (await control.isPaused?.(userId)) { await resume(source.primary, userId); await control.pause(userId, false); return { resumed: true, shardId }; }
    return { unchanged: true };
  }
  let switched = false, paused = false, releaseStarted = false;
  try {
    await control.pause(userId, true); paused = true;
    await pause(source.primary, userId);
    await drain(source.primary, userId);
    await copy(source.primary, target.primary, userId);
    await control.switchUser(userId, shardId); switched = true;
    await resume(target.primary, userId);
    await resume(source.primary, userId);
    releaseStarted = true;
    await control.pause(userId, false);
    return { userId, from: source.shardId, shardId };
  } catch (error) {
    if (releaseStarted) {
      // A lost resume COMMIT reply can mean the target already dispatched. Never revive the old copy.
      error.rollbackFailed = true;
      await control.pause(userId, true).catch(() => {});
      throw error;
    }
    try {
      if (switched) await control.switchUser(userId, source.shardId);
      if (paused && !error.rollbackFailed) { await resume(source.primary, userId); await control.pause(userId, false); }
    } catch { error.rollbackFailed = true; }
    // Uncertain rollback stays paused. A new control must never automatically resume an incomplete copy.
    throw error;
  }
}
