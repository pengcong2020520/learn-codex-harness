import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase, migrate } from '../server/modules/data/database.mjs';
import { fencePool, advanceTerm } from '../server/modules/coordination/fence.mjs';
import { provisionNodeRoles } from '../scripts/cluster-migrate.mjs';

const url = process.env.DATA_TEST_DATABASE_URL;
test('真实 PostgreSQL：新任期先推进；旧 control 在假死窗口写入被 CT001 拒绝并自我隔离；节点运维绕过失败', {
  skip: !url && '通过 npm run test:data 启动独立 PostgreSQL', timeout: 30000,
}, async t => {
  const admin = await openDatabase(url, { maintenance: true }); t.after(() => admin.end());
  await migrate(admin);
  const password = 'integration-only-password-12345678';
  const database = (await admin.query('SELECT current_database() AS name')).rows[0].name;
  await provisionNodeRoles(admin, { a: password, b: password, c: password }, database);
  const pools = [];
  t.after(async () => { for (const pool of pools) await pool.end(); });
  const node = async suffix => {
    const target = new URL(url); target.username = `agent_node_${suffix}`; target.password = password;
    target.searchParams.set('options', '-c app.maintenance=off');
    const pool = await openDatabase(target.href); pools.push(pool); return pool;
  };
  const a = await node('a'), b = await node('b');
  await t.test('每张业务表：节点角色未设置 app.term 的写入必须被 CT001 拒绝', async () => {
    const info = (await a.query("SELECT current_user AS role, current_setting('app.term',true) AS term, current_setting('app.maintenance',true) AS maintenance")).rows[0];
    assert.equal(info.role, 'agent_node_a');
    assert.ok(!info.term);
    assert.equal(info.maintenance, 'off');
    const protectedTables = (await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname='agent_data'
      AND tablename NOT IN ('cluster_term','migrations') ORDER BY tablename`)).rows;
    assert.ok(protectedTables.length > 0);
    for (const { tablename } of protectedTables) {
      assert.match(tablename, /^[a-z_]+$/);
      const triggers = await admin.query(`SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='cluster_term_guard' AND tgenabled='O'`, [`agent_data.${tablename}`]);
      assert.equal(triggers.rowCount, 1, 'missing guard: ' + tablename);
      // A statement trigger must reject even a no-op; no fixture rows/foreign keys are needed.
      await assert.rejects(a.query(`DELETE FROM agent_data.${tablename} WHERE false`), { code: 'CT001' }, tablename);
    }
  });
  const first = (BigInt((await admin.query('SELECT term FROM agent_data.cluster_term WHERE id=1')).rows[0].term) + 1n).toString();
  const second = (BigInt(first) + 1n).toString();
  let isolated = false;
  // assert intentionally does not observe lease loss: this is the paused process's stale local view.
  const old = { term: first, assert() {}, isolate: () => { isolated = true; } };
  const next = { term: second, assert() {}, isolate: () => assert.fail('new term rejected') };
  await advanceTerm(a, old);
  const oldPool = fencePool(a, old), nextPool = fencePool(b, next);
  const instance = randomUUID(), owner = randomUUID();
  await oldPool.query('INSERT INTO agent_data.users(instance_id,id,name) VALUES($1,$2,\'test\')', [instance, owner]);
  await oldPool.query('INSERT INTO agent_data.conversations(instance_id,id,owner_id,cwd) VALUES($1,\'thread\',$2,\'/tmp\')', [instance, owner]);
  await oldPool.query("INSERT INTO agent_data.tasks(instance_id,id,thread_id,text,mode,status,created_at) VALUES($1,'job','thread','test','enqueue','running',1)", [instance]);
  await advanceTerm(b, next);
  assert.equal((await admin.query('SELECT term FROM agent_data.cluster_term')).rows[0].term, second);
  await nextPool.query("UPDATE agent_data.tasks SET status='unconfirmed' WHERE instance_id=$1 AND status IN ('starting','running','steering')", [instance]);
  await assert.rejects(oldPool.query("UPDATE agent_data.tasks SET status='failed' WHERE instance_id=$1", [instance]), { code: 'CT001' });
  assert.equal(isolated, true);
  assert.equal((await admin.query('SELECT status FROM agent_data.tasks WHERE instance_id=$1', [instance])).rows[0].status, 'unconfirmed');
  await assert.rejects(advanceTerm(a, old), { code: 'CT001' });
  await assert.rejects(a.query('UPDATE agent_data.cluster_term SET term=0'), { code: '42501' });
  const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='agent_data' AND tablename NOT IN ('cluster_term','migrations')")).rows;
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    await assert.rejects(oldPool.query(`DELETE FROM agent_data.${tablename} WHERE false`), { code: 'CT001' }, tablename);
    if (tablename === 'permission_events') {
      // The existing audit guard independently forbids DELETE, even with a current term.
      await nextPool.query('INSERT INTO agent_data.permission_events(instance_id,actor_id,action,resource_type,resource_id) SELECT instance_id,actor_id,action,resource_type,resource_id FROM agent_data.permission_events WHERE false');
    } else await nextPool.query(`DELETE FROM agent_data.${tablename} WHERE false`);
  }
  const client = await a.connect();
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL app.maintenance='on'");
    await assert.rejects(client.query('DELETE FROM agent_data.users WHERE false'), { code: '42501' });
    await client.query('ROLLBACK');
  } finally { client.release(); }
  // A promotion waits for an already-writing transaction to commit, so no old COMMIT can land later.
  const writer = await nextPool.connect();
  const promote = await a.connect();
  try {
    await writer.query('BEGIN'); await writer.query('DELETE FROM agent_data.users WHERE false');
    const pid = (await promote.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const third = (BigInt(second) + 1n).toString();
    const promotion = advanceTerm(promote, { term: third, assert() {}, isolate() {} });
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      waiting = (await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock';
      if (waiting) break; await delay(10);
    }
    assert.equal(waiting, true, 'promotion must wait for the old transaction row lock');
    await writer.query('COMMIT'); await promotion;
    assert.equal((await admin.query('SELECT term FROM agent_data.cluster_term')).rows[0].term, third);
  } finally { await writer.query('ROLLBACK'); writer.release(); promote.release(); }
});
