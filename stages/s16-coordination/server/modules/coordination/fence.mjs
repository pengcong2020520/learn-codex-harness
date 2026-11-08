// Local admission fence, not a distributed business-data epoch (that is outside s16).
// Check before every query including COMMIT; ROLLBACK/UNLISTEN remain available for teardown.
export function fencePool(pool, generation) {
  const clients = new WeakMap();
  const wrap = target => {
    if (clients.has(target)) return clients.get(target);
    const proxy = new Proxy(target, { get(object, key) {
      if (key === 'query') return (...args) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
        if (!/^\s*(ROLLBACK|UNLISTEN)\b/i.test(text)) generation.assert();
        return object.query(...args);
      };
      if (key === 'connect') return async () => { generation.assert(); return wrap(await object.connect()); };
      const value = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    clients.set(target, proxy); return proxy;
  };
  return wrap(pool);
}

// Only the old generation's dispatched IDs are eligible. Never recover a new control's work.
export function trackDispatch(jobs, rawPool, instanceId) {
  const ids = new Set();
  const patch = jobs.patch.bind(jobs);
  jobs.patch = async (id, fields, ...rest) => {
    if (['starting', 'running', 'steering'].includes(fields.status)) ids.add(id);
    return patch(id, fields, ...rest);
  };
  return async () => {
    if (!ids.size) return;
    await rawPool.query(`WITH uncertain AS (
      UPDATE agent_data.tasks SET status='unconfirmed',error='control 已失效，执行结果待核对，不自动重发。'
      WHERE instance_id=$1 AND id=ANY($2::text[]) AND status IN ('starting','running','steering') RETURNING thread_id)
      UPDATE agent_data.conversations SET paused=true WHERE instance_id=$1 AND id IN (SELECT thread_id FROM uncertain)`, [instanceId, [...ids]]);
  };
}
