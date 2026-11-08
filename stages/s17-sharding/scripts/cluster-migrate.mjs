// One-shot deployment container only. Runtime nodes never mount .env or receive this password.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { openDatabase, migrate } from '../server/modules/data/database.mjs';
export async function provisionNodeRoles(pool, passwords, database = 'agent_s17') {
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Invalid database');
  for (const [suffix, password] of Object.entries(passwords)) {
    if (!['a', 'b', 'c'].includes(suffix) || !/^[a-zA-Z0-9_-]{24,}$/.test(password || '')) throw new Error('每节点数据库密码至少 24 位字母、数字、下划线或连字符。');
  }
  for (const [suffix, password] of Object.entries(passwords)) {
    const role = `agent_node_${suffix}`;
    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!exists.rowCount) await pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    // Validated alphabet; values are never logged, and ALTER ROLE cannot use a parameter.
    await pool.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    await pool.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await pool.query(`GRANT USAGE ON SCHEMA agent_data TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agent_data TO ${role}`);
    await pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.users, agent_data.auth_sessions, agent_data.agent_versions, agent_data.plans, agent_data.imports FROM ${role}`);
    // plan:assign is the only runtime account mutation. Account administration uses maintenance.
    await pool.query(`GRANT UPDATE(plan_id) ON agent_data.users TO ${role}`);
    await pool.query(`GRANT INSERT, UPDATE(last_seen_at, revoked_at) ON agent_data.auth_sessions TO ${role}`);
    await pool.query(`GRANT INSERT ON agent_data.agent_versions TO ${role}`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_data TO ${role}`);
    await pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.migrations FROM ${role}`);
    await pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.cluster_term FROM ${role}`);
    await pool.query(`GRANT EXECUTE ON FUNCTION agent_data.advance_cluster_term(bigint) TO ${role}`);
  }
}
if (process.argv[1]?.endsWith('/cluster-migrate.mjs') || process.argv[1] === 'scripts/cluster-migrate.mjs') {
  let pool;
  try {
    const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
    const url = new URL('postgresql://agent@postgres:5432/agent_s17'); url.password = env.AGENT_DB_PASSWORD;
    pool = await openDatabase(url.href, { maintenance: true }); await migrate(pool);
    await provisionNodeRoles(pool, Object.fromEntries(['a','b','c'].map(suffix => [suffix, env[`AGENT_NODE_${suffix.toUpperCase()}_DB_PASSWORD`]])));
    console.log('数据库迁移与三个节点最小业务角色已准备。');
  } catch { console.error('迁移或节点角色准备失败；核对 .env 与数据库状态。'); process.exitCode = 1; }
  finally { await pool?.end(); }
}
