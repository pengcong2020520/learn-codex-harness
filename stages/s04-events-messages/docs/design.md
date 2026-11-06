# s04 设计说明：服务端任务队列 + SSE 事件推送

> 本文是设计说明，供深入阅读。章节入门（要回答的问题 → 核心概念 → 分工 → 跑起来看看 → 关键代码）见 [README](../README.md)。

本阶段是独立源码快照。服务监听 `127.0.0.1:4319`，本机开发，单用户，不做公网授权。

## 设计原理

s03 的服务端能常驻、能替客户端发起一轮，但输入的顺序仍由客户端守着，进度也要客户端反复查询。本阶段只加一个单元：**输入在服务端排队，状态由服务端推送**。

三个设计约束：

- **先记录，后执行**：提交只写任务记录并立即返回；是否发送、何时发送由调度器决定。
- **不确定就停**：发出后结果拿不准（超时、连接失效、服务重启）记为 `unconfirmed` 并暂停队列，绝不自动重发。
- **订阅不等于提交**：事件流只读；重连先发完整快照，不会触发任何执行。

## 架构改进

### 1. 新增模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 任务与消息 | [`server/modules/messages/index.mjs`](../server/modules/messages/index.mjs) | 提交（幂等）、按会话串行调度、追加（`turn/steer`）、超时中断、暂停与继续、失败处理 |
| 事件推送 | [`server/modules/events/index.mjs`](../server/modules/events/index.mjs) | 事件中心：给每条事件编序号，按 Thread 分发；不调度、不调用模型 |
| 任务记录 | [`server/modules/data/index.mjs`](../server/modules/data/index.mjs) | 任务与暂停状态写入 `.data/messages.json`（原子替换）；重启时恢复 |

会话模块不再发起轮次，只负责新建 / 恢复 Thread、把 Codex 通知整理成快照，并在每次变化时发布 `session` 事件、在一轮结束时通知调度器。

### 2. 接口变化

| 接口 | 作用 |
|------|------|
| `POST /messages` | 提交一条消息：`threadId`、`clientMessageId`、`text`，可选 `mode: "append"` 与 `targetTurnId`；返回 `202` 和任务记录 |
| `POST /queue/continue` | 解除某个会话的暂停，继续处理排队中的消息 |
| `GET /events?threadId=` | SSE 事件流：首条 `snapshot`，之后 `session` / `queue` / `fatal`，正常关闭时 `shutdown`，每 15 秒一次心跳 |
| `GET /state?threadId=` | 会话快照 + 队列快照 |

### 3. 任务状态

| 状态 | 含义 | 之后 |
|------|------|------|
| `queued` | 已记录，等待调度 | 调度器取出 |
| `starting` / `steering` | 已写盘，正在发 `turn/start` / `turn/steer` | 拿到 turn id 后为 `running` |
| `running` | Codex 正在执行 | 随 `turn/completed` 变为终态 |
| `completed` | 完成 | 继续下一条 |
| `failed` / `interrupted` | 失败或被中断 | 队列暂停 |
| `unconfirmed` | 发出后结果不确定 | 队列暂停，不重发 |

## 技术实现流程

### 调度一次

```text
schedule(threadId)  →  serial(threadId, dispatch)     同一会话的操作串行执行
dispatch:
  暂停中 → 返回
  有指向当前执行轮次的追加 → turn/steer
  已有一轮在执行 → 返回（其余继续排队）
  取追加或最早的一条 → 状态改 starting 并写盘 → turn/start → 记下 turn id，状态 running
turn/completed → 更新任务状态；非 completed 则暂停 → 再次 schedule
```

### 事件流

```text
GET /events
  hub.on(listener)            先订阅：快照发出前到达的事件先暂存
  write(snapshot)             会话快照 + 队列快照
  write(暂存的事件…)
  之后的事件直接写出；积压超过 1 MiB 断开连接，由客户端重连
```

### 重启恢复

启动时 `store.recover()`：`starting` / `running` / `steering` 改为 `unconfirmed` 并暂停所在会话；随后为每个有任务的会话调度一次，排队中的消息继续执行，暂停的会话等待 `/continue`。

## 核心代码

以下为伪代码，说明结构，不是逐行源码。

```js
// server/modules/messages/index.mjs（伪代码）
async function submit({ threadId, clientMessageId, text, mode, targetTurnId }) {
  const existing = store.get(clientMessageId);
  if (existing) return sameContent(existing) ? existing : conflict();   // 幂等
  store.create({ id: clientMessageId, threadId, text, mode, targetTurnId }); // 先写盘
  publish('queue'); schedule(threadId);
  return { status: 'queued' };
}

async function dispatch(threadId) {
  if (store.paused(threadId) || sessions.activeTurn(threadId)) return;
  const job = nextQueued(threadId);                 // 追加优先，否则先进先出
  store.patch(job.id, { status: 'starting' });
  try { const turn = await rpc.request('turn/start', ...); store.patch(job.id, { status: 'running', turnId: turn.id }); }
  catch (error) { store.patch(job.id, { status: sentButUnknown ? 'unconfirmed' : 'failed' }); store.pause(threadId); }
}
```

## 验证

```bash
npm test          # 本机假 Codex，不调用模型
npm run check     # 只检查配置，不启动 Codex
npm run check:server   # 启动 Codex 并握手，不生成回答；需先停止本阶段的服务
npm run smoke     # 需先 npm run server；会调用真实模型
```

## 限制说明

| 限制项 | 说明 |
|--------|------|
| 单进程队列 | 调度在服务进程内进行，任务记录是本地 JSON 文件；同一目录只能运行一个服务 |
| 每个会话最多 100 条待执行消息 | 超过时拒绝新的提交 |
| 本机单用户 | 只监听回环地址，没有多用户认证 |

## 机制实验

在本目录运行 `npm run lesson -- list` 查看课时，运行 `npm run lesson -- <id>` 读取问题、执行验证并观察断言结果。依赖与验证边界见 [实验说明](../lessons/README.md)。
