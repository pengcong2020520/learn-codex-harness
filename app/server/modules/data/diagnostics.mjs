import { shardUser } from '../sharding/fence.mjs';

const token = value => typeof value === 'string' && /^[\w.-]{1,96}$/.test(value) ? value : null;
export const connectionError = error => /^(08\w{3}|57P0[1-5]|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND)$/.test(error?.code || '') ||
  /^(Connection terminated|Connection ended|timeout exceeded when trying to connect)/i.test(error?.message || '');
// Safe category for operators: only the error code or the fixed prefix matched above.
export const connectionKind = error => error?.code ||
  (/^(Connection terminated[^:]*|Connection ended|timeout exceeded when trying to connect)/i.exec(error?.message || '')?.[1] ?? 'unknown');
// Never serialize driver message/detail, SQL values, request URLs or the first stack line:
// any of them can contain credentials, query text, or source content.
export function rowFenceDetail(error) {
  if (error?.code !== 'SH001') return {};
  try {
    const value = JSON.parse(error.detail);
    return Object.fromEntries(['ownerId','shardId','primary','epoch','nodeId','suppliedEpoch'].map(key => [key, token(value[key])]));
  } catch { return {}; }
}
export function errorSummary(error, generation = {}, origin = error, statement = '') {
  let route;
  const userId = shardUser();
  try { route = userId && generation.routes?.routeOf(userId); } catch { /* diagnostic only */ }
  const frames = String(origin?.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 8);
  // Only fixed SQL identifiers survive. Do not print literals, comments or bind values.
  const sql = statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\$([A-Za-z_]\w*|)\$[\s\S]*?\$\1\$/g, ' ');
  const operation = sql.match(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|SELECT|BEGIN|COMMIT|ROLLBACK|LISTEN)\b/i)?.[1]?.toUpperCase() || null;
  const table = token(error?.table) || sql.match(/\bagent_data\.([a-z_]+)\b/i)?.[1] || null;
  return { sqlstate: /^[A-Z0-9]{5}$/.test(error?.code || '') && error.code !== 'EPIPE' ? error.code : null,
    code: token(error?.code), nodeId: token(generation.nodeId), userId: token(userId),
    shardId: token(String(route?.shardId ?? '')), epoch: token(String(route?.epoch ?? '')),
    primary: token(route?.primary), term: token(String(generation.term ?? '')),
    localShards: Object.entries(generation.routes?.shards || {}).filter(([, value]) => value.primary === generation.nodeId)
      .map(([shardId, value]) => ({ shardId: token(shardId), epoch: token(String(value.epoch ?? '')) })),
    operation, table, row: rowFenceDetail(error), frames,
    ...(error?.subprocessDiagnostic ? { subprocess: error.subprocessDiagnostic } : {}) };
}
export function logFailure(error, generation = {}, origin = error, statement = '', kind = 'database', extra = {}) {
  const summary = { ...errorSummary(error, generation, origin, statement), ...extra };
  // Preserve the SQL origin through rollback and the HTTP catch outside the request ALS scope.
  error.databaseDiagnostic ||= summary;
  try { (generation.log || console.error)(`[${kind}] ${JSON.stringify(error.databaseDiagnostic)}`); }
  catch { /* Observability must never replace the original failure. */ }
  return error.databaseDiagnostic;
}

// Raw control metadata transactions use the same safe SQL-origin capture as business fencing.
export function diagnosticClient(client, generation, onFailure = () => {}) {
  return new Proxy(client, { get(target, key) {
    if (key === 'query') return async (...args) => {
      const origin = new Error('control SQL origin');
      try { return await target.query(...args); }
      catch (error) {
        logFailure(error, generation, origin, typeof args[0] === 'string' ? args[0] : args[0]?.text || '', 'control');
        onFailure(error); throw error;
      }
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
