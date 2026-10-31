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
      turnId: null,
      status: "queued",
      error: null,
    });
  }
  patch(id, fields, expected) {
    const job = this.get(id);
    if (expected && !expected.includes(job.status)) return false;
    Object.assign(job, fields);
    return true;
  }
  pause(id, value = true) {
    this.state.paused = this.state.paused.filter((x) => x !== id);
    if (value) this.state.paused.push(id);
  }
  wake() {}
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
export async function testDataFactory() {
  return { jobs: new TestJobs(), async close() {} };
}
