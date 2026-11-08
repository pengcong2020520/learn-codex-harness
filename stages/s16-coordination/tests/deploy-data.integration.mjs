// Run inside a one-off agent container after data:migrate. Uses a fresh UUID scope,
// cleans only its own rows, and never calls models or starts an HTTP listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/modules/data/database.mjs';
import { Repository } from '../server/modules/data/repository.mjs';
import { PostgresJobs } from '../server/modules/data/jobs.mjs';

test('真实 PG：并发创建和确认共享容量锁，全局 200 与会话 100 不被绕过', async () => {
  const pool = await openDatabase(process.env.DATABASE_URL);
  const scope = { instanceId: randomUUID(), ownerId: randomUUID() };
  const repo = new Repository(pool, scope), jobs = new PostgresJobs(pool, scope);
  const create = (id, threadId, status) => jobs.create({ id, threadId, status, text: 'capacity-test', mode: 'enqueue', createdAt: Date.now() });
  try {
    await repo.initialize();
    for (let i = 0; i < 3; i++) await repo.bind(`thread-${i}`, null, '/test-workspace');
    const attempts = await Promise.allSettled(Array.from({ length: 201 }, (_, i) => create(`job-${i}`, `thread-${i % 3}`)));
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 200);
    const rejected = attempts.find(x => x.status === 'rejected').reason;
    assert.equal(rejected.status, 429); assert.equal(rejected.code, 'QUEUE_FULL');
    await create('proposal', 'thread-0', 'proposed');
    await assert.rejects(jobs.patch('proposal', { status: 'queued' }, ['proposed']), e => e.code === 'QUEUE_FULL');
    const queued = (await jobs.list()).filter(j => j.status === 'queued');
    await jobs.patch(queued[0].id, { status: 'starting' }, ['queued']);
    assert.equal(await jobs.patch('proposal', { status: 'queued' }, ['proposed']), true);
    assert.equal((await jobs.list()).filter(j => j.status === 'queued').length, 200);
    // Clear this scope only, then isolate the per-session 100 boundary.
    await pool.query('DELETE FROM agent_data.outbox WHERE instance_id=$1', [scope.instanceId]);
    await pool.query('DELETE FROM agent_data.tasks WHERE instance_id=$1', [scope.instanceId]);
    const local = await Promise.allSettled(Array.from({ length: 101 }, (_, i) => create(`local-${i}`, 'thread-0')));
    assert.equal(local.filter(x => x.status === 'fulfilled').length, 100);
    assert.equal(local.find(x => x.status === 'rejected').reason.code, 'QUEUE_FULL');
  } finally {
    for (const table of ['notifications', 'outbox', 'tasks', 'conversations', 'users']) await pool.query(`DELETE FROM agent_data.${table} WHERE instance_id=$1`, [scope.instanceId]);
    await pool.end();
  }
});
