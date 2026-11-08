import { createClient } from "redis";

// Redis contains only wake-up IDs. PostgreSQL owns ordering, payload and claims.
// A lost/duplicate Redis entry is harmless: the outbox republishes until claimed.
export class RedisQueue {
  constructor(url, instanceId, jobs) {
    if (!url) throw new Error("缺少 REDIS_URL；不会回退为进程内生产队列。");
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: (retries) => Math.min(200 + retries * 200, 2000),
      },
    });
    this.client.on("error", () => {
      this.healthy = false;
    });
    this.commands = this.client.withCommandOptions({ timeout: 2000 });
    this.key = `agent:${instanceId}:ready`;
    this.jobs = jobs;
    this.healthy = false;
  }
  async open() {
    try {
      await Promise.race([
        this.client.connect(),
        new Promise((_, reject) => {
          this.openTimer = setTimeout(() => reject(new Error("timeout")), 3000);
        }),
      ]);
    } catch {
      this.client.destroy();
      throw new Error("无法连接 Redis；请检查 REDIS_URL 和服务状态。");
    } finally {
      clearTimeout(this.openTimer);
    }
  }
  start(deliver, onFatal) {
    this.deliver = deliver;
    this.onFatal = onFatal;
    this.timer = setInterval(() => {
      void this.tick();
    }, 200);
    this.timer.unref();
    void this.tick();
  }
  tick() {
    if (this.closed || this.running) return this.running;
    this.running = this.poll()
      .catch((error) => this.onFatal(error))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  async poll() {
    const rows = await this.jobs.deliveries(); // Database failure stops execution, Redis failure only delays dispatch.
    for (const row of rows) {
      try {
        await this.commands.sAdd(this.key, row.thread_id);
      } catch {
        this.healthy = false;
        return;
      }
      await this.jobs.delivered(row);
    }
    let ids;
    try {
      ids = await this.commands.sPop(this.key, 50);
      this.healthy = true;
    } catch {
      this.healthy = false;
      return;
    }
    for (const id of Array.isArray(ids) ? ids : ids ? [ids] : [])
      this.deliver(id);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    // Destroy first so a disconnected command cannot indefinitely hold shutdown.
    if (this.client.isOpen) this.client.destroy();
    await this.running;
  }
}
