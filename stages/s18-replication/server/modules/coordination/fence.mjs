import { businessQuery, assertTerm, termFailure } from '../data/write.mjs';
export { fencePool } from '../data/write.mjs';

export async function advanceTerm(pool, generation) {
  assertTerm(generation);
  const origin = new Error('推进数据库任期调用栈');
  try {
    await pool.query('SELECT agent_data.advance_cluster_term($1::bigint)', [generation.term]);
    generation.assert();
  } catch (error) {
    termFailure(error, generation, origin, 'SELECT agent_data.advance_cluster_term');
    throw error;
  }
}

// Only the old generation's dispatched IDs are eligible. Never recover a new control's work.
export function trackDispatch(jobs, pool, instanceId) {
  const ids = new Set();
  const patch = jobs.patch.bind(jobs);
  jobs.patch = async (id, fields, ...rest) => {
    if (['starting', 'running', 'steering'].includes(fields.status)) ids.add(id);
    return patch(id, fields, ...rest);
  };
  return async () => {
    if (!ids.size) return;
    await businessQuery(pool, `WITH uncertain AS (
      UPDATE agent_data.tasks SET status='unconfirmed',error='control 已失效，执行结果待核对，不自动重发。'
      WHERE instance_id=$1 AND id=ANY($2::text[]) AND status IN ('starting','running','steering') RETURNING thread_id)
      UPDATE agent_data.conversations SET paused=true WHERE instance_id=$1 AND id IN (SELECT thread_id FROM uncertain)`, [instanceId, [...ids]]);
  };
}
