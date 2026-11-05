const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 启动/更新的短锁，不是消息队列。状态通过小接口注入，不持有 SessionService。
export class ExecutionBoundary {
  constructor() { this.chain = Promise.resolve(); this.isBusy = () => false; }
  serial(operation) {
    const next = this.chain.catch(() => {}).then(operation);
    this.chain = next;
    return next;
  }
  async run(operation, { allowBusy = false } = {}) {
    for (;;) {
      const result = await this.serial(async () => {
        if (this.closed || this.unavailable?.()) throw new Error("执行边界不可用，请检查服务端。");
        await this.refresh?.();
        if (this.pending?.() && this.isBusy()) return allowBusy ? { value: await operation() } : { wait: true };
        if (this.pending?.()) await this.apply();
        if (this.unavailable?.()) throw new Error("工具恢复失败，已停止新任务。");
        return { value: await operation() };
      });
      if (!result.wait) return result.value;
      await sleep(30);
    }
  }
}
