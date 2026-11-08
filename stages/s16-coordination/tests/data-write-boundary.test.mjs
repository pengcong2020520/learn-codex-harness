import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const files = directory => fs.readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap(entry => {
  const file = path.posix.join(directory, entry.name);
  return entry.isDirectory() ? files(file + '/') : file.endsWith('.mjs') ? [file] : [];
});
// Exact raw calls only: adding even a second statement invalidates the allowlist.
// No business DML is allowed here. The term singleton is control metadata, not a business table.
const allowed = [
  ["scripts/cluster-migrate.mjs", "pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`ALTER ROLE ${role} PASSWORD '${password}'`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT USAGE ON SCHEMA agent_data TO ${role}`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agent_data TO ${role}`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_data TO ${role}`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.migrations FROM ${role}`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.cluster_term FROM ${role}`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT EXECUTE ON FUNCTION agent_data.advance_cluster_term(bigint) TO ${role}`)", "一次性管理员角色/权限配置，无业务 DML；连接显式 maintenance:true。"],
  ["scripts/upgrade-sessions.mjs", "pool.query(\n          \"SELECT descriptor FROM agent_data.agent_versions WHERE instance_id=$1 AND hash=$2\",", "停服升级工具，只读旧 Agent 描述；连接显式 maintenance:true。"],
  ['server/modules/coordination/fence.mjs', "pool.query('SELECT agent_data.advance_cluster_term($1::bigint)',", '推进任期必须先于业务 fence；受专用 PG 函数/节点权限保护。'],
  ['server/modules/deployment/index.mjs', "pool.query({ text: 'SELECT 1', query_timeout: 3000 })", '只读健康探测。'],
  ['server/modules/hub/index.mjs', "client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')", '只读权限快照的事务属性，client 来自 transaction(data.pool)。'],
  ['server/modules/hub/index.mjs', "client.query('SELECT id FROM agent_data.plans WHERE id=$1',", '只读套餐枚举，client 来自 transaction(data.pool)。'],
  ['server/modules/runtimes/index.mjs', "pool.query('SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2',", '只读运行目录查询，pool 是 data.pool。'],
  ['server/modules/runtimes/store.mjs', "client.query('UNLISTEN agent_runtime_disabled')", '失效后仍需释放 LISTEN，不访问业务表。'],
  ['server/modules/accounts/admin.mjs', "client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',", '账号运维/启动串行锁，无表写入。'],
  ['server/modules/knowledge/worker.mjs', "client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))',", '知识任务串行锁，client 来自 transaction(data.pool)。'],
];
// Match unknown SQL variables too, not just literal INSERT/UPDATE/DELETE. This catches CTEs,
// multiline calls and object query configs without trying to parse SQL with a regexp.
const directCalls = source => [...source.matchAll(/\b(?:pool|client|db|rawPool)\s*\.\s*query\s*\(/g)];
function violations(file, source) {
  return directCalls(source).filter(match => !allowed.some(([name, prefix]) => name === file && source.slice(match.index).startsWith(prefix)))
    .map(match => `${file}:${source.slice(0, match.index).split('\n').length}`);
}

test('静态 grep：数据层以外禁止直接 pool/client.query，例外逐条注明只读/运维原因', () => {
  const failures = [];
  for (const file of [...files('server/'), ...files('scripts/')].filter(file => !file.startsWith('server/modules/data/'))) {
    failures.push(...violations(file, fs.readFileSync(new URL(file, root), 'utf8')));
  }
  assert.deepEqual(failures, []);
  for (const [file, prefix, reason] of allowed) {
    assert.ok(reason);
    assert.equal(fs.readFileSync(new URL(file, root), 'utf8').split(prefix).length - 1, 1, '过期/重复允许项: ' + file + ': ' + prefix);
  }
  // No new pg pools/clients or business driver forwarding outside the audited data layer.
  for (const file of files('server/')) {
    const source = fs.readFileSync(new URL(file, root), 'utf8');
    if (!['server/modules/data/database.mjs', 'server/modules/data/write.mjs'].includes(file)) {
      assert.doesNotMatch(source, /from\s*['"]pg['"]|import\s*\(['"]pg['"]\)|new\s+(?:Pool|Client)\s*\(/, file);
    }
  }
  for (const file of ['data/repository.mjs', 'accounts/store.mjs', 'hub/index.mjs']) {
    const source = fs.readFileSync(new URL('server/modules/' + file, root), 'utf8');
    assert.match(source, /return businessQuery\(client, sql,/, file);
  }
});

test('静态守护能发现多行/CTE/变量/查询对象形式，不能在允许 SELECT 后夹带 DML', () => {
  for (const source of [
    "pool.query(`INSERT INTO agent_data.tasks VALUES(1)`)",
    "client\n .query(\n `WITH x AS (DELETE FROM agent_data.tasks RETURNING *) SELECT * FROM x`)",
    'this.pool.query(sql, values)',
    "client.query({text: 'UPDATE agent_data.tasks SET error=NULL'})",
    "client.query('SELECT id FROM agent_data.plans WHERE id=$1; DELETE FROM agent_data.tasks', [])",
  ]) assert.equal(violations('server/modules/hub/index.mjs', source).length, 1, source);
});
