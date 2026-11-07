import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

// 只传播状态，不调用模型，也不调度任务。
export class EventHub extends EventEmitter {
  constructor({ history = 500 } = {}) {
    super(); this.setMaxListeners(100); this.sequence = 0;
    // 事件 ID 带进程前缀：服务重启后，旧连接带来的 Last-Event-ID 不会误配到新进程的同号事件。
    this.epoch = randomBytes(4).toString("hex");
    this.history = []; this.historyLimit = history;
  }
  publish(type, data, threadId = null) {
    const event = { sequence: ++this.sequence, type, threadId, data };
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();
    this.emit("event", event);
    return event;
  }
  eventId(sequence) { return `${this.epoch}-${sequence}`; }
  // 返回 Last-Event-ID 之后发给该会话的事件。不是本进程的 ID、或缓冲已经覆盖不到时返回 null，调用方改发快照。
  since(lastEventId, threadId) {
    const match = /^([0-9a-f]{8})-(\d{1,15})$/.exec(lastEventId || "");
    if (!match || match[1] !== this.epoch) return null;
    const sequence = Number(match[2]);
    if (sequence > this.sequence || (this.history[0]?.sequence ?? this.sequence + 1) > sequence + 1) return null;
    return this.history.filter(event => event.sequence > sequence && (!event.threadId || event.threadId === threadId));
  }
}
