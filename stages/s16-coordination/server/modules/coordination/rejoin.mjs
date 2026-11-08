// One recovery loop per process. No new lease until all old user processes have exited.
export class Rejoin {
  constructor(coordination, service, { sleep = ms => new Promise(resolve => { this.timer = setTimeout(resolve, ms); this.wake = resolve; }) } = {}) {
    Object.assign(this, { coordination, service, sleep });
    this.listener = () => { void this.run(); };
    coordination.on('lost', this.listener);
  }
  run() {
    return this.pending ||= this.recover().finally(() => {
      this.pending = null;
      // A campaign may lose its lease while the successful join is resolving.
      if (!this.closed && !this.coordination.closed && !this.coordination.alive) queueMicrotask(() => { void this.run(); });
    });
  }
  async recover() {
    const c = this.coordination;
    let backoff = 2000;
    while (!this.closed && !c.closed) {
      try {
        await this.service.stop();
        if (this.closed || c.closed) return;
        await c.leaveGeneration();
        if (this.closed || c.closed) return;
        await c.join();
        await c.watchMembers();
        if (this.closed || c.closed) return;
        c.campaign();
        if (!c.checkLease()) throw new Error('campaign lost lease');
        c.record('rejoined'); return;
      } catch {
        c.isolate('rejoin-failed');
        if (this.closed || c.closed) return;
        c.record('rejoin-retry', { delayMs: backoff });
        await this.sleep(backoff);
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }
  close() {
    this.closed = true; this.coordination.off('lost', this.listener);
    clearTimeout(this.timer); this.wake?.();
    return this.pending;
  }
}
