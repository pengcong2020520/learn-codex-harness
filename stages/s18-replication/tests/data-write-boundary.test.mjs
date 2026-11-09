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
  ["server/modules/sharding/control.mjs", "db.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES($1,$2,$3)\n          ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch,\n            replica=CASE WHEN shard_owners.node_id IS NOT DISTINCT FROM EXCLUDED.node_id AND shard_owners.epoch=EXCLUDED.epoch THEN shard_owners.replica ELSE NULL END,\n            replica_ready=CASE WHEN shard_owners.node_id IS NOT DISTINCT FROM EXCLUDED.node_id AND shard_owners.epoch=EXCLUDED.epoch THEN shard_owners.replica_ready ELSE false END,\n            previous_primary=CASE WHEN shard_owners.node_id IS NOT DISTINCT FROM EXCLUDED.node_id AND shard_owners.epoch=EXCLUDED.epoch THEN shard_owners.previous_primary ELSE NULL END`", "协调元数据：写入只在 locked() CT001 事务中；实例/分片/epoch 范围查询只读。"],
  ["server/modules/replication/control.mjs", "db.query(`SELECT 1 FROM agent_data.user_shards u JOIN agent_data.users a ON a.id=u.user_id\n      LEFT JOIN agent_data.replication_positions p ON p.user_id=u.user_id AND p.shard_id=u.shard_id AND p.epoch=$2\n      LEFT JOIN agent_data.replication_transfers x ON x.user_id=u.user_id AND x.shard_id=u.shard_id AND x.epoch=$2\n      WHERE u.shard_id=$1 AND a.instance_id=$3 AND a.username IS NOT NULL\n        AND (p.user_id IS NULL OR x.user_id IS NOT NULL) LIMIT 1`", "协调元数据：写入只在 locked() CT001 事务中；实例/分片/epoch 范围查询只读。"],
  ["server/modules/replication/control.mjs", "db.query(`UPDATE agent_data.shard_owners SET replica=previous_primary,replica_ready=false,publishing=true\n          WHERE shard_id=$1 AND replica IS NULL AND previous_primary<>node_id AND NOT recovering AND NOT publishing`", "协调元数据：写入只在 locked() CT001 事务中；实例/分片/epoch 范围查询只读。"],
  ["server/modules/replication/control.mjs", "db.query('SELECT id FROM agent_data.users WHERE instance_id=$1 AND id NOT IN (SELECT user_id FROM agent_data.user_shards)'", "协调元数据：写入只在 locked() CT001 事务中；实例/分片/epoch 范围查询只读。"],
  ["server/modules/replication/control.mjs", "pool.query('SELECT * FROM agent_data.shard_owners ORDER BY shard_id'", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],
  ["server/modules/replication/control.mjs", "db.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch,replica,publishing) VALUES($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],
  ["server/modules/replication/control.mjs", "db.query(`UPDATE agent_data.shard_owners SET publishing=false WHERE shard_id=$1 AND epoch=$2 AND node_id=$3 AND replica IS NOT DISTINCT FROM $4`", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],
  ["server/modules/replication/control.mjs", "db.query('SELECT * FROM agent_data.shard_owners WHERE shard_id=$1 FOR UPDATE'", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],
  ["server/modules/replication/control.mjs", "db.query(`UPDATE agent_data.shard_owners SET previous_primary=node_id,node_id=replica,replica=NULL,\n        epoch=epoch+1,replica_ready=false,publishing=true,recovering=true,paused=false WHERE shard_id=$1`", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],
  ["server/modules/replication/control.mjs", "db.query('UPDATE agent_data.shard_owners SET replica_ready=true WHERE shard_id=$1'", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],
  ["server/modules/replication/control.mjs", "db.query('UPDATE agent_data.shard_owners SET recovering=false WHERE shard_id=$1 AND epoch=$2 AND node_id=$3 AND NOT publishing RETURNING shard_id'", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],
  ["server/modules/replication/control.mjs", "db.query('UPDATE agent_data.shard_owners SET paused=true WHERE shard_id=$1'", "协调元数据：写入只在继承的 locked() CT001 事务中；rows() 只读。"],

  ["server/modules/sharding/control.mjs", "db.query(\"SELECT set_config('app.term',$1,true),agent_data.locked_cluster_term()\"", "etcd 故障时只以已有 PG 任期记录 failed，不推进任期。"],
  ["server/modules/coordination/node.mjs", "pool.query('SELECT count(*)::int AS n FROM agent_data.user_shards')", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/fence.mjs", "client.query(\"SELECT set_config('app.node',$1,true),set_config('app.shard_epoch',$2,true)\",", "分片事务的 SET LOCAL 上下文；业务行由 SH001 触发器保护。"],
  ["server/modules/sharding/runtime.mjs", "pool.query('SELECT u.paused OR coalesce(s.paused OR s.publishing OR s.recovering,false) AS paused,u.shard_id,s.node_id,s.epoch FROM agent_data.user_shards u JOIN agent_data.shard_owners s USING(shard_id) WHERE user_id=$1',", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/runtime.mjs", "pool.query('SELECT user_id,shard_id,paused FROM agent_data.user_shards WHERE user_id=$1',", "admin 路由诊断只读 PG 用户归属与暂停状态，与本节点缓存比较；不修改路由或业务表。"],
  ["server/modules/sharding/runtime.mjs", "pool.query('SELECT user_id FROM agent_data.user_shards')", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],

  ["scripts/upgrade-sessions.mjs", "pool.query(\n          \"SELECT descriptor FROM agent_data.agent_versions WHERE instance_id=$1 AND hash=$2\",", "停服升级工具，只读旧 Agent 描述；连接显式 maintenance:true。"],
  ['server/modules/coordination/fence.mjs', "pool.query('SELECT agent_data.advance_cluster_term($1::bigint)',", '推进任期必须先于业务 fence；受专用 PG 函数/节点权限保护。'],
  ['server/modules/deployment/index.mjs', "pool.query({ text: 'SELECT 1', query_timeout: 3000 })", '只读健康探测。'],
  ['server/modules/hub/index.mjs', "client.query('SELECT id FROM agent_data.plans WHERE id=$1',", '只读套餐枚举，client 来自 transaction(data.pool)。'],
  ['server/modules/runtimes/index.mjs', "pool.query('SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2',", '只读运行目录查询，pool 是 data.pool。'],
  ['server/modules/runtimes/store.mjs', "client.query('UNLISTEN agent_runtime_disabled')", '失效后仍需释放 LISTEN，不访问业务表。'],
  ['server/modules/accounts/admin.mjs', "client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',", '账号运维/启动串行锁，无表写入。'],
  ['server/modules/knowledge/worker.mjs', "client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,15))',", '知识任务串行锁，client 来自 transaction(data.pool)。'],
  ["server/modules/sharding/control.mjs", "db.query('SELECT agent_data.advance_cluster_term($1::bigint)'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query(\"SELECT set_config('app.term',$1,true)\"", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('SELECT agent_data.locked_cluster_term()'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('SELECT id FROM agent_data.users WHERE id NOT IN (SELECT user_id FROM agent_data.user_shards)'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('SELECT * FROM agent_data.move_operations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND paused'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,$2) ON CONFLICT DO NOTHING'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "pool.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET paused=$2 WHERE user_id=$1'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query(`SELECT u.*,s.node_id FROM agent_data.user_shards u JOIN agent_data.shard_owners s USING(shard_id) WHERE user_id=$1 FOR UPDATE OF u`", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('SELECT node_id FROM agent_data.shard_owners WHERE shard_id=$1'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query(`INSERT INTO agent_data.move_operations(id,user_id,from_shard,to_shard,control_node,source_node,target_node,state)\n        VALUES($1,$2,$3,$4,$5,$6,$7,'paused') RETURNING *`", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET paused=true WHERE user_id=$1', [userId])", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "connection.query(`UPDATE agent_data.move_operations SET state=$3 WHERE id=$1 AND state=$2 AND expires_at>now() AND control_node=$4 RETURNING *`", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query(\"UPDATE agent_data.move_operations SET state='failed' WHERE id=$1 RETURNING *\"", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET paused=true WHERE user_id=$1', [op.user_id])", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET paused=false WHERE user_id=$1 AND shard_id=$2 RETURNING user_id'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND shard_id=$3 AND paused RETURNING user_id'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT owner_id FROM agent_data.${type} WHERE instance_id=$1 AND id=$2`", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT s.node_id,count(*)::int AS users FROM agent_data.user_shards u JOIN agent_data.shard_owners s USING(shard_id) JOIN agent_data.users a ON a.id=u.user_id WHERE a.instance_id=$1 AND a.username IS NOT NULL GROUP BY s.node_id`", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "pool.query('SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "pool.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT EXISTS(SELECT 1 FROM agent_data.tasks t JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id WHERE c.instance_id=$1 AND c.owner_id=$2 AND t.status IN ('starting','running','steering')) OR EXISTS(SELECT 1 FROM agent_data.knowledge_jobs j JOIN agent_data.knowledge_bases k ON k.instance_id=j.instance_id AND k.id=j.kb_id WHERE j.instance_id=$1 AND k.owner_id=$2 AND j.state='running') AS busy`", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "db.query('SELECT pg_try_advisory_lock(hashtextextended($1,17)) AS locked'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "db.query('SELECT pg_advisory_unlock(hashtextextended($1,17))'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "pool.query('SELECT 1 FROM agent_data.user_shards WHERE user_id=$1'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT v.blob AS file,'blob' AS kind,v.revision AS digest FROM agent_data.resource_versions v JOIN agent_data.resources r ON r.instance_id=v.instance_id AND r.id=v.resource_id WHERE r.instance_id=$1 AND r.owner_id=$2\n    UNION SELECT v.blob,'blob',v.revision FROM agent_data.wiki_versions v JOIN agent_data.knowledge_bases k ON k.instance_id=v.instance_id AND k.id=v.kb_id WHERE k.instance_id=$1 AND k.owner_id=$2\n    UNION SELECT i.revision::text || '.json','index',i.manifest->>'bm25Hash' FROM agent_data.knowledge_indexes i JOIN agent_data.knowledge_bases k ON k.instance_id=i.instance_id AND k.id=i.kb_id WHERE k.instance_id=$1 AND k.owner_id=$2 AND i.state='ready'`", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["scripts/cluster-migrate.mjs", "pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1'", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`ALTER ROLE ${role} PASSWORD '${password}'`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT USAGE ON SCHEMA agent_data TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agent_data TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.users, agent_data.auth_sessions, agent_data.agent_versions, agent_data.plans, agent_data.imports FROM ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT UPDATE(plan_id) ON agent_data.users TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT INSERT, UPDATE(last_seen_at, revoked_at) ON agent_data.auth_sessions TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT INSERT ON agent_data.agent_versions TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_data TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.migrations FROM ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`REVOKE INSERT, UPDATE, DELETE ON agent_data.cluster_term FROM ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["scripts/cluster-migrate.mjs", "pool.query(`GRANT EXECUTE ON FUNCTION agent_data.advance_cluster_term(bigint) TO ${role}`", "maintenance 运维连接配置全局表最小列权限。"],
  ["server/modules/sharding/operations.mjs", "pool.query('SELECT * FROM agent_data.move_operations WHERE id=$1 AND expires_at > now()'", "只读迁移校验/路由查询；迁移元数据写入仅在 control.locked 任期事务中。"],
  ["server/modules/knowledge/worker.mjs", "client.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1 FOR SHARE'", "恢复前持有映射共享锁；暂停事务等待已开始的恢复，暂停后不修改知识行。"],
];
// Match unknown SQL variables too, not just literal INSERT/UPDATE/DELETE. This catches CTEs,
// multiline calls and object query configs without trying to parse SQL with a regexp.
const directCalls = source => [...source.matchAll(/\b(?:pool|client|db|rawPool|connection)\s*\.\s*query\s*\(/g)];
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
    assert.equal(fs.readFileSync(new URL(file, root), 'utf8').split(prefix).length - 1, file === 'server/modules/replication/control.mjs' && prefix === "db.query('SELECT * FROM agent_data.shard_owners WHERE shard_id=$1 FOR UPDATE'" ? 3 : 1, '过期/重复允许项: ' + file + ': ' + prefix);
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
