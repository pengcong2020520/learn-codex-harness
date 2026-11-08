import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { AppError } from '../../../shared/errors.mjs';
import { signalUserProcess, userEnvironment } from '../codex/launch.mjs';

export const RUNTIME_LIMIT = 4;
export const IDLE_MS = 10 * 60 * 1000;
export const START_TIMEOUT_MS = 30 * 1000;
export const CLOSE_TIMEOUT_MS = 10 * 1000;
export const busyError = () => Object.assign(new AppError('用户运行环境繁忙，请稍后重试。', 503, 'RUNTIME_BUSY'), { retryAfter: 10 });

// admission 只保护名额与租约；启动在锁外进行，不阻塞其他用户。
export class RuntimePool extends EventEmitter {
  constructor({ create, isBusy = async () => false, assertEnabled = async () => {}, onLost = async () => {}, onRemoved = () => {}, shouldRestart = async () => false, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, log = console.warn, signalProcess = signalUserProcess }) {
    super();
    Object.assign(this, { create, isBusy, assertEnabled, onLost, onRemoved, shouldRestart, now, setTimer, clearTimer, log, signalProcess });
    this.closingValues = new WeakMap();
    this.entries = new Map(); this.context = new AsyncLocalStorage(); this.chain = Promise.resolve(); this.disabled = new Set();
  }
  serial(operation) {
    const next = this.chain.catch(() => {}).then(operation); this.chain = next; return next;
  }
  current(owner) {
    const entry = this.context.getStore();
    return entry && entry.owner === owner && entry.state === 'ready' ? entry.value : null;
  }
  async idle(entry) {
    if (entry.state !== 'ready' || entry.refs) return false;
    try { return !await this.isBusy(entry.owner); }
    catch (error) {
      this.log(`运行环境 ${entry.owner} 忙碌查询失败，本轮跳过回收：${error.message}`);
      return false;
    }
  }
  closeValue(value) {
    if (this.closingValues.has(value)) return this.closingValues.get(value);
    const closing = (async () => {
      let timer;
      try {
        const timeout = new Promise(resolve => { timer = this.setTimer(() => resolve(true), CLOSE_TIMEOUT_MS); });
        // close 抛错也应强杀；所有入口共享同一次清理和超时。
        const stopped = Promise.resolve().then(() => value.close()).then(() => false, error => {
          this.log(`运行环境关闭失败：${error.message}`); return true;
        });
        if (await Promise.race([stopped, timeout])) {
          const child = value.rpc.child;
          if (child?.pid && child.exitCode == null && child.signalCode == null) {
            if (value.runtime?.isolated) await this.signalProcess(child.pid, 'SIGKILL', {
              ...value.runtime, env: userEnvironment(value.rpc.launch?.env || {}, value.runtime.codexHome),
            });
            else child.kill('SIGKILL');
          }
        }
      } finally { this.clearTimer(timer); }
    })();
    this.closingValues.set(value, closing);
    return closing;
  }
  async withOwner(owner, operation) {
    if (!owner) throw new Error('运行环境缺少可信 owner。');
    const nested = this.context.getStore();
    if (nested?.owner === owner && nested.state === 'ready' && !this.disabled.has(owner) && !this.closed)
      return operation(nested.value);
    const entry = await this.serial(async () => {
      if (this.closed) throw new AppError('运行环境池已关闭。', 503);
      if (this.disabled.has(owner)) throw new AppError('账号已禁用。', 403, 'ACCOUNT_DISABLED');
      await this.assertEnabled(owner);
      let entry = this.entries.get(owner);
      if (entry?.state === 'closing') throw busyError();
      if (entry?.state === 'ready' && !entry.refs && await this.shouldRestart(owner, entry.value)) { await this.remove(entry); entry = null; }
      if (!entry) {
        if (this.entries.size >= RUNTIME_LIMIT) {
          let victim;
          for (const candidate of [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
            if (await this.idle(candidate)) { victim = candidate; break; }
          }
          if (!victim) throw busyError();
          await this.remove(victim);
        }
        entry = { owner, refs: 0, lastUsed: this.now(), state: 'starting', controller: new AbortController() };
        this.entries.set(owner, entry);
        entry.ready = this.start(entry);
        entry.ready.catch(() => {});
      }
      entry.refs++; entry.lastUsed = this.now();
      return entry;
    });
    try {
      const value = await entry.ready;
      if (entry.state !== 'ready') throw new AppError('运行环境已关闭，请核对任务。', 503);
      return await this.context.run(entry, () => operation(value));
    } finally {
      entry.refs--; entry.lastUsed = this.now();
      if (this.sweeping && entry.state === 'ready') {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => { void this.sweep().catch(error => this.emit('error', error)); }, IDLE_MS);
        entry.idleTimer.unref();
      }
    }
  }
  async start(entry) {
    let timer;
    // create 必须响应 signal，且在 publish 前检查 abort；晚到的进程也必须关闭。
    const creating = Promise.resolve().then(() => this.create(entry.owner, entry.controller.signal));
    entry.creating = creating;
    const aborted = new Promise((_, reject) => {
      entry.controller.signal.addEventListener('abort', () => reject(entry.controller.signal.reason), { once: true });
      timer = this.setTimer(() => entry.controller.abort(new AppError('用户运行环境启动超时。', 503, 'RUNTIME_START_TIMEOUT')), START_TIMEOUT_MS);
    });
    try {
      const value = await Promise.race([creating, aborted]);
      entry.controller.signal.throwIfAborted();
      entry.value = value;
      value.rpc.on('fatal', error => { void this.crash(entry, error).catch(error => this.emit('error', error)); });
      if (value.rpc.failure) throw value.rpc.failure;
      entry.state = 'ready';
      return value;
    } catch (error) {
      entry.state = 'closing';
      entry.controller.abort(error);
      // 请求在期限到达时失败；尚未完成的清理仍占名额，绝不能短暂超过 4 个进程。
      entry.cleanup = creating.then(value => this.closeValue(value), () => {});
      void entry.cleanup.then(() => {
        if (!entry.removing && this.entries.get(entry.owner) === entry) this.entries.delete(entry.owner);
      }).catch(error => this.emit('error', error));
      throw error;
    } finally { this.clearTimer(timer); }
  }
  async remove(entry, error) {
    if (entry.removing) return entry.removing;
    entry.state = 'closing';
    clearTimeout(entry.idleTimer);
    entry.controller.abort(error || new Error('运行环境已回收。'));
    entry.removing = (async () => {
      // 先停止进程与工具；确认任务状态后才释放名额，防止迟到通知与新进程交叉。
      if (entry.value) await this.closeValue(entry.value);
      else await entry.creating?.then(value => this.closeValue(value), () => {});
      if (error) await this.onLost(entry.owner, error);
      await this.onRemoved(entry.owner);
      if (this.entries.get(entry.owner) === entry) this.entries.delete(entry.owner);
    })();
    return entry.removing;
  }
  crash(entry, error) { return this.serial(() => this.entries.get(entry.owner) === entry ? this.remove(entry, error) : undefined); }
  disable(owner) {
    this.disabled.add(owner);
    const entry = this.entries.get(owner);
    // 不等待 admission：立即中止启动/进程；持久化在串行链上收尾。
    entry?.controller.abort(new Error('账号已禁用，执行结果待核对。'));
    if (entry?.value) void this.closeValue(entry.value).catch(error => this.emit('error', error));
    return this.serial(() => entry ? this.remove(entry, new Error('账号已禁用，执行结果待核对。')) : this.onLost(owner, new Error('账号已禁用。')));
  }
  sweep() {
    return this.serial(async () => {
      for (const entry of this.entries.values()) {
        if (this.now() - entry.lastUsed >= IDLE_MS && await this.idle(entry)) await this.remove(entry);
      }
    });
  }
  startSweeper() {
    this.sweeping = true;
    this.timer = setInterval(() => { void this.sweep().catch(error => this.emit('error', error)); }, IDLE_MS);
    this.timer.unref();
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const entry of this.entries.values()) {
      entry.controller.abort(new Error('服务正在关闭。'));
      if (entry.value) void this.closeValue(entry.value).catch(error => this.emit('error', error));
    }
    return this.serial(async () => { for (const entry of this.entries.values()) await this.remove(entry); });
  }
}
