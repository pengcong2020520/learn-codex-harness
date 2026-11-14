import path from 'node:path';
import { currentIdentity } from '../server/modules/accounts/context.mjs';
import { AppError } from '../shared/errors.mjs';
import { accountFixture } from './accounts-fixture.mjs';
// Unit-test double only; production has no JSON or memory fallback.
export class TestJobs {
  constructor(state = { jobs: [], paused: [] }) {
    this.state = state;
  }
  get(id) {
    return this.state.jobs.find((j) => j.id === id);
  }
  list(threadId) {
    return this.state.jobs.filter((j) => !threadId || j.threadId === threadId);
  }
  paused(id) {
    return this.state.paused.includes(id);
  }
  create(job) {
    if (
      this.list(job.threadId).filter((j) => j.status === "queued").length >= 100
    )
      throw new Error("最多 100 条");
    this.state.jobs.push({
      ...job,
      step: 0,
      note: null,
      reviseCount: 0,
      turnId: null,
      status: job.status === "proposed" ? "proposed" : "queued",
      error: null,
    });
  }
  patch(id, fields, expected) {
    const job = this.get(id);
    if (!job || (expected && !expected.includes(job.status))) return false;
    Object.assign(job, fields);
    return true;
  }
  pause(id, value = true) {
    this.state.paused = this.state.paused.filter((x) => x !== id);
    if (value) this.state.paused.push(id);
  }
  wake() {}
  allPending() { return this.state.jobs.filter(job => !['completed', 'failed', 'cancelled'].includes(job.status)); }
  recoverOwner(reason) {
    for (const job of this.state.jobs) if (job.userId === currentIdentity().userId && ['starting', 'running', 'steering'].includes(job.status)) {
      job.status = 'unconfirmed'; job.error = reason; this.pause(job.threadId);
    }
  }
  recover(reason) {
    for (const job of this.state.jobs) {
      if (["starting", "running", "steering"].includes(job.status)) {
        job.status = "unconfirmed";
        job.error = reason;
      }
      if (job.status === "unconfirmed") this.pause(job.threadId);
    }
  }
}
export async function testDataFactory(config) {
  const { accounts, store } = await accountFixture(), rows = new Map(), mappings = new Map();
  const repository = {
    saveAgent: async () => {},
    bind: async (id, hash, cwd) => rows.set(id, { id, owner_id: currentIdentity().userId, agent_hash: hash, cwd, name: 'fixture' }),
    conversation: async id => { const row = rows.get(id); if (!row || row.owner_id !== currentIdentity().userId) throw new AppError('未找到本项目的这个会话。', 404, 'THREAD_NOT_FOUND'); return row; },
    listConversations: async () => [...rows.values()].filter(row => row.owner_id === currentIdentity().userId),
    recordArtifacts: async () => {},
  };
  const runtimeStore = {
    async assertEnabled(owner) { if (!store.users.some(user => user.id === owner && !user.disabled_at)) throw new Error('disabled'); },
    async ensure(owner) {
      if (!mappings.has(owner)) mappings.set(owner, { user_id: owner, uid: 10001 + mappings.size, codex_home: path.join(config.root, '.data/users', owner, 'codex') });
      return mappings.get(owner);
    },
    listen: async () => async () => {},
  };
  return { accounts, repository, runtimeStore, jobs: new TestJobs(), async close() {} };
}
