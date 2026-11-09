// All inputs come from PG. Keep bigint comparisons exact; task sequences are global.
export function takeoverAdvanced(row) {
  return Boolean(row.previous_primary) && BigInt(row.epoch || 0) > BigInt(row.replication_epoch || 0)
    && BigInt(row.epoch || 0) > 1n;
}
export function replicaSessionMissing(row) {
  return takeoverAdvanced(row) && (!row.replicated_at || row.created_after_replication === true);
}
export function replicaTailMissing(row) {
  if (!takeoverAdvanced(row)) return false;
  return !row.replicated_at || row.created_after_replication === true
    || BigInt(row.last_completed_sequence || 0) > BigInt(row.last_task_sequence || 0);
}
export function resumeFailure(error) {
  return Number.isInteger(error?.code) || /thread.*(?:not found|does not exist)|no rollout found/i.test(error?.message || '');
}
// Scope both the position and the task aggregate to the owning conversation/user/shard.
export const lossStateSql = `SELECT c.*,s.epoch,s.previous_primary,p.epoch AS replication_epoch,
  p.last_task_sequence,p.replicated_at,(c.created_at>p.replicated_at) AS created_after_replication,
  coalesce((SELECT max(t.sequence) FROM agent_data.tasks t
    WHERE t.instance_id=c.instance_id AND t.thread_id=c.id),0)::text AS last_sequence,
  coalesce((SELECT max(t.sequence) FROM agent_data.tasks t
    WHERE t.instance_id=c.instance_id AND t.thread_id=c.id
    AND t.status IN ('completed','replica_missing')),0)::text AS last_completed_sequence
  FROM agent_data.conversations c
  JOIN agent_data.user_shards u ON u.user_id=c.owner_id
  JOIN agent_data.shard_owners s ON s.shard_id=u.shard_id
  LEFT JOIN agent_data.replication_positions p ON p.user_id=c.owner_id AND p.shard_id=u.shard_id
  WHERE c.instance_id=$1 AND c.owner_id=$2`;
