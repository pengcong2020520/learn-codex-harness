import { EventEmitter } from "node:events";

// 只传播状态，不调用模型，也不调度任务。
export class EventHub extends EventEmitter {
  constructor() { super(); this.setMaxListeners(100); this.sequence = 0; }
  publish(type, data, threadId = null) {
    const event = { sequence: ++this.sequence, type, threadId, data };
    this.emit("event", event);
    return event;
  }
}
