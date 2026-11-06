import path from 'node:path';
import { readJson, writeJson } from '../storage/index.mjs';
import { AppError } from '../../../shared/errors.mjs';

export const executing = ["starting", "running", "steering"];
export const terminal = ["completed", "failed", "interrupted"];

// 任务记录：.data/messages.json。读写都是同步的，每次改动整体原子替换文件。
export class JsonJobs {
  constructor(file) {
    this.file = file;
    this.state = readJson(file, { version: 1, jobs: [], paused: [] });
    if (this.state.version !== 1 || !Array.isArray(this.state.jobs) || !Array.isArray(this.state.paused)) throw new Error('任务 JSON 格式无效。');
  }
  mutate(operation) {
    const next = structuredClone(this.state), result = operation(next);
    writeJson(this.file, next); this.state = next; return result;
  }
  get(id) { return this.state.jobs.find(j => j.id === id); }
  list(threadId) { return this.state.jobs.filter(j => !threadId || j.threadId === threadId); }
  paused(id) { return this.state.paused.includes(id); }
  create(job) {
    if (this.get(job.id)) throw new AppError('消息 ID 重复。', 409, 'IDEMPOTENCY_CONFLICT');
    if (this.list(job.threadId).filter(j => j.status === 'queued').length >= 100) throw new AppError('最多 100 条待执行消息，请等前面的执行完再提交。', 429, 'QUEUE_FULL');
    this.mutate(s => s.jobs.push({ ...job, turnId: null, status: 'queued', error: null }));
  }
  patch(id, fields, expected) {
    const job = this.get(id);
    if (!job || (expected && !expected.includes(job.status))) return false;
    this.mutate(s => Object.assign(s.jobs.find(j => j.id === id), fields)); return true;
  }
  pause(id, value = true) { this.mutate(s => { s.paused = s.paused.filter(x => x !== id); if (value) s.paused.push(id); }); }
  recover(reason) {
    this.mutate(s => {
      for (const job of s.jobs) {
        if (['starting','running','steering'].includes(job.status)) { job.status = 'unconfirmed'; job.error = reason; }
        if (job.status === 'unconfirmed' && !s.paused.includes(job.threadId)) s.paused.push(job.threadId);
      }
    });
  }
}
export function openData(config) {
  return { jobs: new JsonJobs(path.join(config.root, '.data/messages.json')) };
}
