# s03 设计说明：常驻服务端 + 终端客户端

> 本文是设计说明，供深入阅读。章节入门（要回答的问题 → 核心概念 → 分工 → 跑起来看看 → 关键代码）见 [README](../README.md)。

本阶段是独立源码快照。服务监听 `127.0.0.1:4313`，本机开发，单用户，不做公网授权。

## 设计原理

s02 的聊天程序把三件事放在一个进程里：读终端输入、驱动 Codex、保管会话状态。进程一退出，三件事一起结束。云端 Agent 需要的是：执行和状态常驻，交互可以随时来去。所以本阶段只做一件事，把这个进程拆成两半：

1. **服务端常驻**：读取 `.env`，启动并持有 Codex App Server，发起每一轮、接收通知、保管会话快照。
2. **客户端无状态**：只知道服务地址和连接令牌，经 HTTP 提交和查看，退出不影响服务端。

三个设计约束：

- **交出去的一轮归服务端**：`POST /turns` 返回时 `turn/start` 已经发出，客户端断开不取消执行。
- **服务端暂不排队**：同一会话一次只允许一轮在执行，否则返回 `409`。排队调度和事件推送是下一个单元。
- **只服务本机客户端**：只监听回环地址，连接令牌认证，拒绝带 `Origin` 的网页请求。

## 架构改进

### 1. 服务端模块

| 模块 | 文件 | 职责 |
|------|------|------|
| HTTP 接口 | [`server/modules/http/index.mjs`](../server/modules/http/index.mjs) | 认证、读请求体（只收 JSON，限 512 KiB）、路由到会话模块 |
| 会话 | [`server/modules/sessions/index.mjs`](../server/modules/sessions/index.mjs) | 新建 / 恢复 Thread，发起一轮，把通知整理成快照 |
| 生命周期 | [`server/modules/lifecycle/index.mjs`](../server/modules/lifecycle/index.mjs) | 登记清理动作、倒序关闭；发布与回收连接文件 |
| 运行目录维护 | [`server/modules/maintenance/index.mjs`](../server/modules/maintenance/index.mjs) | 定期清理旧的 `.runs/app-server-*`，保护使用中的目录 |
| 基础设施 | `config/`、`storage/`、`codex/`、`role/` | 配置读取、原子写文件与独占锁、Codex 进程与 JSON-RPC、固定角色 |

主流程 [`server/main.mjs`](../server/main.mjs) 只做编排：配置 → 独占锁 → 运行目录 → Codex 配置与连接 → 会话 → 维护 → HTTP → 发布连接文件。

### 2. 客户端模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 连接 | [`client/modules/connection/index.mjs`](../client/modules/connection/index.mjs) | 读连接文件，带令牌发请求；`follow()` 轮询快照直到这一轮结束 |
| 聊天 | [`client/modules/chat/index.mjs`](../client/modules/chat/index.mjs) | 命令解析、逐条提交、把快照增量渲染成流式回复 |
| 终端 | [`client/modules/terminal/index.mjs`](../client/modules/terminal/index.mjs) | 流式输出与输入框重绘，过滤控制字符 |

### 3. 接口

| 接口 | 作用 |
|------|------|
| `GET /health` | 服务是否就绪、当前模型；Codex 连接失效时返回 503 |
| `GET /sessions?q=` | 搜索本项目的会话 |
| `POST /sessions` | 新建会话 |
| `POST /sessions/resume` | 载入一个已有会话 |
| `GET /state?threadId=` | 会话快照：最近 30 轮的回复与状态 |
| `POST /turns` | 发起一轮，立即返回 `202` 和 turn id；上一轮未结束返回 `409` |

### 4. 状态放在哪

| 位置 | 内容 | 生命周期 |
|------|------|---------|
| `.data/connection.json` | 服务地址、连接令牌、进程号 | 服务运行期间 |
| `.data/server.lock` | 独占锁 | 服务运行期间 |
| `.data/codex/` | Codex 原生历史与生成的 `config.toml` | 长期 |
| `.data/session-index.json` | 被清理运行目录里的会话位置 | 长期 |
| `.runs/app-server-*/` | 模型目录、协议日志、运行标记 | 按保留规则清理 |
| `workspace/` | Codex 的固定工作目录 | 长期 |

## 技术实现流程

### 启动与关闭

```text
loadServerConfig()                 读 .env，端口默认 4313
acquireServerLock()        ─┐      同一目录只允许一个服务
prepareRun()                │      新建 .runs/app-server-*，写 run.json
prepareCodexConfig()        │      生成 .data/codex/config.toml（关闭原生记忆）
CodexConnection.open()      │      启动 App Server 子进程并握手
SessionService              │      订阅 Codex 通知
RunMaintenance.start()      │      立即检查一次，之后每小时一次
http.listen()               │      127.0.0.1:端口
publishConnection()        ─┘      写 .data/connection.json（0600）
关闭或启动失败：按登记的相反顺序逐个清理
```

### 一轮的走向

```text
POST /turns → sessions.startTurn()
  ├─ 会话未载入：先 ensure()（必要时 thread/resume）
  ├─ activeTurnId 存在或正在发起：409
  └─ turn/start → 记录 turn（早到的 completed 不会被改回 inProgress）
Codex 通知（turn/started、item/*、turn/completed）→ handleNotification() 更新快照
客户端 follow()：每 200 ms GET /state，直到这一轮不再是 inProgress
```

### 清理规则

保留最近 5 次运行和 7 天内修改过的目录；其余目录逐个检查，满足任一条件就跳过：是当前运行目录、有会话正在加载或已加载、`run.json` 记录的进程仍然存活、`lsof` 发现文件被打开、目录里有运行缓存以外的内容或链接。删除前先把协议日志里的会话位置写进会话索引，并在删除前一刻重新核对目录没有变化。

## 核心代码

以下为伪代码，说明结构，不是逐行源码。

```js
// server/main.mjs（伪代码）
async function startAgentServer(config) {
  const lifecycle = createLifecycle();               // 清理动作按登记的相反顺序执行
  lifecycle.defer(acquireServerLock(config.root));
  const runtime = await prepareRun(config.launch, config.root);
  const rpc = new CodexConnection({ ... });  lifecycle.defer(() => rpc.close());
  await rpc.open();
  const sessions = new SessionService({ rpc, ... });
  const maintenance = new RunMaintenance({ ... });  await maintenance.start();
  const http = createHttpService({ token: randomToken(), sessions, rpc });
  publishConnection(config.root, { url: await http.listen(), token }, lifecycle);
}

// client/modules/chat/index.mjs（伪代码）
for each line typed by user:
  if (!current) current = POST /sessions
  turnId = POST /turns { threadId: current.id, text: line }
  await follow(current.id, turnId, renderSnapshot)   // 客户端退出只是停止查看
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
| 不排队 | 同一会话上一轮未结束时拒绝新提交；客户端退出后，尚未发出的输入不会保留 |
| 轮询查看 | 客户端每 200 ms 查询一次快照，没有事件推送 |
| 服务重启 | 重启时执行中的那一轮会随 Codex 子进程结束；历史仍在 `.data/codex`，但没有任务记录可供核对 |
| 本机单用户 | 只监听回环地址，没有多用户认证 |

## 机制实验

在本目录运行 `npm run lesson -- list` 查看课时，运行 `npm run lesson -- <id>` 读取问题、执行验证并观察断言结果。依赖与验证边界见 [实验说明](../lessons/README.md)。
