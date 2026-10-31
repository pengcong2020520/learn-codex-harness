import path from 'node:path';
import { readJson, writeJson } from '../storage/index.mjs';
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
    if (this.get(job.id)) throw new Error('消息 ID 重复。');
    if (this.list(job.threadId).filter(j => j.status === 'queued').length >= 100) throw new Error('最多 100 条待执行消息。');
    this.mutate(s => s.jobs.push({ ...job, turnId: null, status: 'queued', error: null }));
  }
  patch(id, fields, expected) {
    const job = this.get(id);
    if (!job || (expected && !expected.includes(job.status))) return false;
    this.mutate(s => Object.assign(s.jobs.find(j => j.id === id), fields)); return true;
  }
  pause(id, value = true) { this.mutate(s => { s.paused = s.paused.filter(x => x !== id); if (value) s.paused.push(id); }); }
  wake() {}
  recover(reason) {
    this.mutate(s => {
      for (const job of s.jobs) {
        if (['starting','running','steering'].includes(job.status)) { job.status = 'unconfirmed'; job.error = reason; }
        if (job.status === 'unconfirmed' && !s.paused.includes(job.threadId)) s.paused.push(job.threadId);
      }
    });
  }
}
export async function openData(config) {
  const jobs = new JsonJobs(path.join(config.root, '.data/messages.json'));
  return { jobs, async close() {} };
}
