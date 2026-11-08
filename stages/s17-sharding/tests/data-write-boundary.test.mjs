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
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND paused=true',", "COMMIT 响应丢失后，在 control.locked 中同时补偿 SQL 映射与 override。"],
  ["server/modules/coordination/node.mjs", "pool.query('SELECT count(*)::int AS n FROM agent_data.user_shards')", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/control.mjs", "db.query('SELECT agent_data.advance_cluster_term($1::bigint)',", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query(\"SELECT set_config('app.term',$1,true)\",", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query('SELECT agent_data.locked_cluster_term()')", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query(`INSERT INTO agent_data.shard_owners(shard_id,node_id,epoch) VALUES($1,$2,$3)\n          ON CONFLICT(shard_id) DO UPDATE SET node_id=EXCLUDED.node_id,epoch=EXCLUDED.epoch`,", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query('SELECT id FROM agent_data.users WHERE id NOT IN (SELECT user_id FROM agent_data.user_shards)')", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1 AND paused',", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query('INSERT INTO agent_data.user_shards(user_id,shard_id) VALUES($1,$2) ON CONFLICT DO NOTHING',", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "pool.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1',", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET paused=$2 WHERE user_id=$1',", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/control.mjs", "db.query('UPDATE agent_data.user_shards SET shard_id=$2 WHERE user_id=$1',", "control.locked 内的任期锁与分片协调元数据写入，受 cluster_term 保护。"],
  ["server/modules/sharding/fence.mjs", "client.query(\"SELECT set_config('app.node',$1,true),set_config('app.shard_epoch',$2,true)\",", "分片事务的 SET LOCAL 上下文；业务行由 SH001 触发器保护。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT owner_id FROM agent_data.${type} WHERE instance_id=$1 AND id=$2`,", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT s.node_id,count(*)::int AS users FROM agent_data.user_shards u JOIN agent_data.shard_owners s USING(shard_id) JOIN agent_data.users a ON a.id=u.user_id WHERE a.instance_id=$1 AND a.username IS NOT NULL GROUP BY s.node_id`,", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "pool.query('SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2',", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "pool.query('SELECT paused FROM agent_data.user_shards WHERE user_id=$1',", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT EXISTS(SELECT 1 FROM agent_data.tasks t JOIN agent_data.conversations c ON c.instance_id=t.instance_id AND c.id=t.thread_id WHERE c.instance_id=$1 AND c.owner_id=$2 AND t.status IN ('starting','running','steering')) OR EXISTS(SELECT 1 FROM agent_data.media_jobs WHERE instance_id=$1 AND owner_id=$2 AND status NOT IN ('completed','failed')) OR EXISTS(SELECT 1 FROM agent_data.knowledge_jobs j JOIN agent_data.knowledge_bases k ON k.instance_id=j.instance_id AND k.id=j.kb_id WHERE j.instance_id=$1 AND k.owner_id=$2 AND j.state='running') AS busy`,", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "db.query('SELECT pg_try_advisory_lock(hashtextextended($1,17)) AS locked',", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "db.query('SELECT pg_advisory_unlock(hashtextextended($1,17))',", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "pool.query('SELECT 1 FROM agent_data.user_shards WHERE user_id=$1',", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/http.mjs", "pool.query(`SELECT v.blob AS file,'blob' AS kind,v.revision AS digest FROM agent_data.resource_versions v JOIN agent_data.resources r ON r.instance_id=v.instance_id AND r.id=v.resource_id WHERE r.instance_id=$1 AND r.owner_id=$2\n    UNION SELECT v.blob,'blob',v.revision FROM agent_data.wiki_versions v JOIN agent_data.knowledge_bases k ON k.instance_id=v.instance_id AND k.id=v.kb_id WHERE k.instance_id=$1 AND k.owner_id=$2\n    UNION SELECT i.revision::text || '.json','index',i.manifest->>'bm25Hash' FROM agent_data.knowledge_indexes i JOIN agent_data.knowledge_bases k ON k.instance_id=i.instance_id AND k.id=i.kb_id WHERE k.instance_id=$1 AND k.owner_id=$2 AND i.state='ready'`,", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/runtime.mjs", "pool.query('SELECT paused,shard_id FROM agent_data.user_shards WHERE user_id=$1',", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],
  ["server/modules/sharding/runtime.mjs", "pool.query('SELECT user_id FROM agent_data.user_shards')", "只读路由/调度/迁移元数据查询或会话 advisory lock，不写业务表。"],

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
