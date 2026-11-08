import { connectionError, logFailure } from './diagnostics.mjs';
import { setShard, shardFailure } from '../sharding/fence.mjs';
import { Pool, Client } from 'pg';

const admissions = new WeakMap();
const programmingError = () => Object.assign(new Error('业务写入缺少本节点任期；必须使用 fencePool 或显式运维连接。'), { code: 'TERM_REQUIRED' });
export function assertTerm(generation) {
  generation.assert();
  if (generation.routes) return;
  if (!/^[1-9]\d*$/.test(String(generation.term))) throw programmingError();
}
// Only database.mjs registers administrative connections. PostgreSQL still checks rolsuper.
export function maintenanceConnection(connection) { admissions.set(connection, () => {}); }
// All repositories and business services use this entry. Plain objects are injected offline doubles;
// real pg connections must be fenced or explicitly registered by openDatabase as maintenance.
export function businessQuery(connection, ...args) {
  const admit = admissions.get(connection);
  if (admit) admit();
  else if (connection instanceof Pool || connection instanceof Client) throw programmingError();
  return connection.query(...args);
}

export function termFailure(error, generation, origin, statement) {
  if (error.code !== 'CT001' || error.termDiagnostic) return;
  let current = true;
  try { generation.assert(); } catch { current = false; }
  const diagnostic = current ? '任期过期或漏传任期' : '任期已失效';
  error.termDiagnostic = { diagnostic, term: generation.term, stack: origin.stack, statement };
  try { logFailure(error, generation, origin, statement, 'CT001', { diagnostic }); }
  catch { /* Logging must not replace CT001 or prevent isolation. */ }
  finally { generation.isolate?.('database-stale-term'); }
}

// Every SQL statement uses a transaction-local term, including implicit pool.query writes.
// Explicit transactions retain one client and one term through COMMIT.
export function fencePool(pool, generation) {
  const clients = new WeakMap();
  const report = async (error, origin, statement) => {
    // Record every driver failure, including SQL errors returned as HTTP 500.
    if (!['CT001', 'SH001'].includes(error.code)) logFailure(error, generation, origin, statement);
    termFailure(error, generation, origin, statement);
    await shardFailure(error, generation, origin, statement);
    if (connectionError(error) && !error.connectionIsolated) {
      error.connectionIsolated = true; generation.isolate?.('database-connection-lost');
    }
  };
  pool.on?.('error', error => { void report(error, new Error('PG idle connection'), ''); });
  const checkout = async origin => {
    try { return await pool.connect(); }
    catch (error) { await report(error, origin, ''); throw error; }
  };
  const setTerm = client => {
    assertTerm(generation);
    if (generation.routes) return setShard(client, generation);
    return client.query(`SET LOCAL app.term = '${generation.term}'`);
  };
  const wrap = target => {
    if (clients.has(target)) return clients.get(target).proxy;
    let inTransaction = false, latestOrigin = new Error('PG checked out connection'), latestStatement = '';
    target.on?.('error', error => { void report(error, latestOrigin, latestStatement); });
    const query = (args, origin = new Error('业务 SQL 调用栈')) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
      latestOrigin = origin; latestStatement = text;
      const statement = text.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
      const cleanup = /^(ROLLBACK|UNLISTEN)\b/i.test(statement);
      if (!cleanup) assertTerm(generation);
      const failure = async error => { if (!error.databaseDiagnostic) await report(error, origin, text); throw error; };
      return (async () => {
        if (/^SET\s+(?:(?:LOCAL|SESSION)\s+)?TRANSACTION\b/i.test(statement))
          throw Object.assign(new Error('编程错误：隔离包装已在 BEGIN 后设置事务上下文，禁止 SET TRANSACTION；请使用 transaction(pool, fn, { isolation, readOnly })，在同一条 BEGIN 中声明事务特性。'), { code: 'TRANSACTION_OPTIONS_REQUIRED' });
        if (/^BEGIN\b/i.test(statement)) {
          const result = await target.query(...args); inTransaction = true;
          await setTerm(target); return result;
        }
        if (/^(COMMIT|ROLLBACK)\b/i.test(statement)) {
          try { return await target.query(...args); } finally { inTransaction = false; }
        }
        if (inTransaction || cleanup) return target.query(...args);
        await target.query('BEGIN');
        try {
          await setTerm(target);
          assertTerm(generation);
          const result = await target.query(...args);
          generation.assert();
          await target.query('COMMIT'); return result;
        } catch (error) {
          await report(error, origin, text); // Record and close admission before rollback/network cleanup.
          await target.query('ROLLBACK').catch(() => {}); throw error;
        }
      })().catch(failure);
    };
    const proxy = new Proxy(target, { get(object, key) {
      if (key === 'query') return (...args) => query(args);
      const value = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    admissions.set(proxy, () => assertTerm(generation));
    clients.set(target, { proxy, query }); return proxy;
  };
  const fenced = new Proxy(pool, { get(object, key) {
    if (key === 'connect') return async () => { assertTerm(generation); return wrap(await checkout(new Error('PG checkout'))); };
    if (key === 'query') return (...args) => {
      assertTerm(generation);
      const origin = new Error('业务 SQL 调用栈');
      return (async () => {
        const client = await checkout(origin);
        try { wrap(client); return await clients.get(client).query(args, origin); } finally { client.release(); }
      })();
    };
    const value = Reflect.get(object, key);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  admissions.set(fenced, () => assertTerm(generation));
  return fenced;
}

