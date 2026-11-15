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
    return this.state.jobs.find((j) => j.id === id && (!j.userId || !currentIdentity() || j.userId === currentIdentity().userId));
  }
  list(threadId) {
    return this.state.jobs.filter((j) => (!threadId || j.threadId === threadId) && (!j.userId || !currentIdentity() || j.userId === currentIdentity().userId));
  }
  paused(id) {
    return this.state.paused.includes(id);
  }
  workflowTasks(workflows) {
    return this.list(null).filter(job => workflows.includes(job.workflow) && job.mode !== 'append' && !['completed', 'cancelled'].includes(job.status)).map(({ id, workflow }) => ({ id, workflow }));
  }
  workflowOccupancy(workflow) {
    const job = this.state.jobs.find(job => job.single && job.workflow === workflow && !['completed', 'cancelled'].includes(job.status));
    return job ? { taskId: job.userId === currentIdentity()?.userId ? job.id : null, username: job.username || 'fixture', startedAt: job.createdAt } : null;
  }
  async cancelTakeoverWorkflow(workflow, startedAt, workflows) {
    return this.cancelTakeover(null, null, workflows, { workflow, startedAt });
  }
  async cancelTakeover(threadId, taskId, workflows, byWorkflow) {
    const actor = this.users?.find(user => user.id === currentIdentity()?.userId && user.role === 'admin' && !user.disabled_at);
    if (!actor) throw new AppError('只有管理员可以接管结束任务。', 403);
    const job = this.state.jobs.find(job => (byWorkflow ? job.workflow === byWorkflow.workflow && !['completed', 'cancelled'].includes(job.status) : job.id === taskId && job.threadId === threadId) && job.userId !== actor.id
      && job.single && workflows.includes(job.workflow) && this.users.some(user => user.id === job.userId && user.role === 'admin'));
    if (!job) throw new AppError(byWorkflow ? '任务不存在或不允许接管结束' : '任务不存在或不允许接管结束。', 404);
    if (byWorkflow && job.createdAt !== byWorkflow.startedAt) throw new AppError('占用已变化，请刷新后核对', 409);
    ({ id: taskId, threadId } = job);
    if (['starting', 'running', 'steering'].includes(job.status)) throw new AppError('任务正在运行，请等这一步完成或失败后再操作。', 409);
    if (!['queued', 'waiting', 'proposed', 'failed', 'needs-review', 'unconfirmed'].includes(job.status)) throw new AppError('当前状态不能接管结束，请刷新后核对任务记录。', 409);
    job.status = 'cancelled'; job.error = `已被管理员 ${actor.username} 结束`;
    (this.audit ||= []).push({ actorId: actor.id, ownerId: job.userId, taskId, createdAt: Date.now() });
    return { id: taskId, threadId, userId: job.userId, status: 'cancelled' };
  }
  feedback(id, note, attachments) {
    const job = this.get(id);
    if (!job) throw new AppError('任务不存在。', 404);
    if (!['queued', 'waiting'].includes(job.status)) throw new AppError('任务状态已变化，请刷新后核对意见是否需要重新提交。', 409);
    const mode = job.status === 'waiting' ? 'revise' : 'queued';
    if (job.status === 'waiting') {
      if (job.reviseCount >= 10) throw new AppError('本步已重做 10 次，请确认继续或结束任务', 409);
      job.note = note; job.reviseCount++;
    }
    job.status = 'queued'; job.feedback.push({ text: note, attachments });
    return mode;
  }
  create(job) {
    if (job.single && this.workflowOccupancy(job.workflow)) {
      const occupied = this.workflowOccupancy(job.workflow);
      throw Object.assign(new AppError('这个工作流已有进行中的任务，请等当前任务完成或结束后再提交。', 409, 'WORKFLOW_OCCUPIED'), { occupant: { username: occupied.username, startedAt: occupied.startedAt } });
    }
    if (
      this.list(job.threadId).filter((j) => j.status === "queued").length >= 100
    )
      throw new Error("最多 100 条");
    this.state.jobs.push({
      ...job,
      step: 0,
      note: null,
      feedback: [],
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
    // 与 Repository.bind 的 ON CONFLICT 相同：id 已被别人占用时不能改 owner，否则后创建的会话会接管先创建的。
    bind: async (id, hash, cwd) => {
      const owner = currentIdentity().userId;
      const existing = rows.get(id);
      if (existing && (existing.owner_id !== owner || existing.agent_hash !== hash))
        throw new AppError('会话归属或 Agent 版本冲突。', 409);
      rows.set(id, { id, owner_id: owner, agent_hash: hash, cwd, name: existing?.name || 'fixture' });
    },
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
