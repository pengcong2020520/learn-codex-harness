# 数据层升级工程文档

> **适用版本**：s04 数据层（单机单用户）
> **文档位置**：`app/docs/data-layer.md`，同步至 `stages/s04-data-layer/docs/data-layer.md`
> **读者**：略懂代码的初学者，需理解本期边界、改法原理及如何复现排查

> **知识层设计基线**：[知识层架构方案](knowledge-layer-design.md)。复用本文数据层与 Codex 原生执行，通过通用权限门禁统一授权；资源模块负责版本与来源，Wiki 更新校验通过后自动生效，可选 RAG。s05 已实现的具体范围见 [知识层实现说明](knowledge-implementation.md)，设计中的扩展项不等于已实现。

---

## 设计原理

### 为什么要换掉 JSON 文件

旧方案已有 temp+rename 原子替换和单服务文件锁，但仍缺少以下能力：

- **跨业务记录事务**：升级后的任务、会话、版本和 outbox 需要关系约束及多记录事务，原有文件接口不提供这些能力
- **关系约束**：资源版本、来源声明、派生关系无法在文件层面强制
- **持久调度交接**：旧实现能恢复 JSON 中的任务并暂停待核对执行，但缺少跨存储调度所需的事务 outbox 与补投机制

PostgreSQL 解决的是这几个结构性缺陷，**不解决文件系统、模型存储、Redis 之间的跨系统原子性**——那类问题需要跨介质补偿机制，本期通过 outbox + PG 兜底处理。

Redis 不替代文件，而是加速任务调度唤醒：已落 PG 的 Thread ID 投入 Redis Set，消费者每 200ms 取出，真正的任务状态以 PG 为准。

### 本期新增能力

除数据层替换外，本期也新增了以下能力：

- 资源永久 ID（resourceId）和版本/谱系追踪（versionId、revision）
- 来源声明与失效传播（read_file 返回版本 ID，write_file 接收 source_versions）
- 偏好 API（preferences 表）
- 通知终态记录（notifications 表）
- 导入记录（imports 表）

### 存储分工判断标准

```
问：这份数据丢了，业务会出错吗？
  是 → PostgreSQL（持久权威）
  否，仅用于加速调度 → Redis（短期，可从 PG 重建）
  是文件正文本身 → 文件系统（不可变 blob）
  是 Codex 自己的 Thread/Turn/记忆 → Codex 原生，不动
```

角色文件、Agent JSON、原生 Skill 文件仍是可编辑的权威配置，PG 保存其 hash 和使用关系，不把 PG descriptor 当可编辑配置。

`tasks` 表保存用户输入文本，`preferences` 保存偏好文本；完整聊天历史仍由 Codex 保存，资料正文放在文件存储，不在 PostgreSQL 再维护一份完整副本。

### 身份设计

`.data/identity.json` 持久化 `instanceId` 和 `ownerId`，是整个 PG 数据归属的根。

复制部署新实例时，不要复制 `.data/identity.json` 和运行状态文件。`app/` 和 `s04-data-layer/` 各自生成独立身份，可共享同一台机器的 PG/Redis，数据在应用层通过 `instanceId` 隔离——这不等于 OS 级别的敌对租户隔离。

### 资源版本设计原则

- **resourceId（UUID）**：资源永久身份，路径不是身份
- **versionId（UUID）**：某次内容的版本身份
- **revision（sha256）**：内容 hash，用于去重和校验

同路径内容改变 → 生成新 versionId，resourceId 不变。复制到新路径 → 默认生成新 resourceId，不自动猜测重命名关系。

`resources` 表持有 `state` 和 `current_version`；`resource_versions` 记录不可变版本元数据，无 `state` 列。

---

## 架构改进

### 整体结构对比

```
旧方案：
  HTTP请求 → Agent → 读写 JSON文件（temp+rename原子替换，单服务锁）→ 返回

新方案：
  HTTP请求 → Agent → Repository（PG事务） ──→ 返回
                              │
                              └─→ Redis Set（投递Thread ID唤醒）
                                        │
                              消费者每200ms轮询
                                        │
                              PG决定FIFO、CAS状态流转
```

### 各表职责

schema 中全部表：`users`（含 local-owner 占位）、`agent_versions`、`conversations`、`tasks`、`outbox`、`notifications`（任务终态记录）、`resources`、`resource_versions`、`dependencies`、`artifacts`、`preferences`、`imports`、`migrations`。

企业外部订单等数据仍以外部系统为权威，受控连接器本期未接入。

### 数据模块文件职责

所有数据层代码位于 [server/modules/data](../server/modules/data/)：

| 文件 | 职责 |
|---|---|
| `database.mjs` | PG 连接池（max 6）、schema 核验、实例专用 advisory lock + 1s heartbeat |
| `repository.mjs` | Agent 版本、业务会话、偏好、产物的读写，固定 instance/owner 归属 |
| `jobs.mjs` | 任务、outbox、通知的事务操作 |
| `queue.mjs` | Redis 写入和消费 Thread ID |
| `resources.mjs` | 资源身份/版本/权限/来源/正文快照登记 |
| `files.mjs` | 复用原有路径检查和文件读写限制 |
| `legacy.mjs` | 旧 JSON 导入 |
| `index.mjs` | 组装并对外导出 |
| `schema.sql` | 第 1 版完整建表 DDL，无 ORM |

### 启动顺序（关键）

```
main()
  ├─ 写 .data/server.lock（防重复启动）
  ├─ openData()
  │    ├─ PG 连接：失败则立即报错退出（不会只启动 Codex 子进程）
  │    ├─ schema 核验：仅比对，不自动执行 migration
  │    ├─ PG advisory lock（实例独占）+ 1s heartbeat
  │    └─ Redis 连通性检查：失败则立即报错退出
  ├─ 装配 Agent、Resources 包装、工具、Codex
  ├─ saveAgent()（写入 PG agent_versions）
  ├─ MessageService.open()（恢复任务/会话状态）
  └─ HTTP 就绪，开始接受请求
```

`migration` 仅通过 `npm run data:migrate` 显式执行。`openData` 和 `main` 只做 schema 核验，发现不一致则报错退出，**不自动迁移，不静默回退到 JSON**。

### 任务调度状态机

```
queued（未暂停）→ starting/steering（CAS，PG原子）→ running
                                                        │
                                         成功：持久产物 → 调度下一条
                                         明确失败 → failed；中断 → interrupted；结果不明 → unconfirmed

重启时：starting/running/steering → unconfirmed 并暂停
        queued 且线程未暂停、无 unconfirmed → 补投
        failed/中断（interrupted）：明确拒绝，不转 unconfirmed
        只有受理结果不明确才转 unconfirmed
```

- `/continue` 仅解除暂停，允许继续下一条任务；**永不重置 unconfirmed**，需人工核查原生历史后确认
- 线程调度器还会检查串行约束、活动 turn 与 paused 状态再决定是否推进

---

## 技术实现流程

### 读取文件（资源登记）

第一次 `read_file` 读取某文件时：

1. 校验路径在四类允许目录内（≤ 256KiB，`.md`/`.txt`，不跟软硬链接）
2. 计算正文 sha256，写不可变 blob 快照至 `.data/files/objects/<sha256>.txt`
3. 在同一 PG 事务内登记资源、不可变版本及 ready 状态；已登记资源还需检查归属、有效状态和来源权限
4. 返回限长正文及 `resourceId` / `versionId`。读取不会重新创建或覆盖 workspace 原文件

后续读取同路径：检测内容是否变化，若变则生成新版本，递归将引用该资源的派生标记为 `stale`。

读取登记失败可能留下未被数据库引用的 blob，暂时保留，不自动删除。写入流程的 pending 恢复见下节。

### 写入文件（带来源声明）

`write_file` 的 `source_versions: [{resourceId, versionId}]` 为可选参数，值从 `read_file` 返回的元数据取，**不要自己猜测**。声明来源只登记关系，不代表捕获了所有依赖；未声明的引用不参与失效传播。

实际写入顺序：

1. 校验参数、路径、大小
2. 先写不可变 blob 快照（create-only，不覆盖已有 blob）
3. PG 事务预留 `pending` 记录（含期望版本和依赖关系）
4. 以 create-only 方式写 workspace 指定文件
5. PG 核验状态与来源后更新为 `ready`

步骤 2 成功但后续步骤失败，会留下孤立 blob 或 pending 状态，修复见"数据修复"。

### 失效传播

失效触发条件不限于 `read_file(A)`：直接读取派生文件或 `GET /resources/read` 时同样核对上游实际文件 hash；外部修改或删除上游文件会使派生资源标记为 `stale` 并在读取时拒绝返回旧正文。

失效检查是**按需触发**，没有后台文件 watcher，也不会自动重写人工知识内容。`write_file` 的 `source_versions` 是声明式的，不捕获所有依赖。

```
外部工具修改文件 A
  → 下次 read_file(A) 或派生文件读取时检测到 hash 变化
  → A 生成新版本
  → 递归标记所有声明引用 A 的派生资源为 stale
  → 读取这些派生内容时，拒绝返回旧正文

来源资源被撤销
  → 停服后：node scripts/data.mjs revoke '替换为真实的资源UUID'
  → DB 立即标 revoked，派生资源标 stale
  → 已发送给模型的旧正文无法召回
```

### 会话与 Thread 的映射

业务会话的 PG `id` 等于 Codex 原生 Thread id。`owner`/`agent_hash`/`cwd`/`name` 存在 PG；聊天完整正文历史仍从原生 thread/resume 获取。PG 可按会话名称/ID 搜索（上限 200 条），不支持聊天全文搜索。

---

## 核心代码

> 以下为伪代码，说明关键设计意图，不是可直接运行的实现。

### 实例锁与 heartbeat

```pseudo
// database.mjs
async function acquireInstanceLock(client, instanceId):
    lockKey = hashToInt64(instanceId)
    acquired = await client.query(
        "SELECT pg_try_advisory_lock($1)", [lockKey]
    )
    if not acquired:
        throw Error("另一实例正在运行，拒绝启动")

    // advisory lock 是合作式锁，随连接释放，不是权限隔离系统
    startHeartbeat(interval=1000ms, dedicatedConnection):
        每1s在专用连接上执行 SELECT 1 核查连接存活
        若连接丢失 → 锁自动释放 → stopScheduler() + closeCodex() + 报错
```

参考：[node-postgres 事务](https://node-postgres.com/features/transactions) · [PostgreSQL advisory lock](https://www.postgresql.org/docs/16/explicit-locking.html)

### 任务创建与 outbox（同一事务，Thread 为键）

```pseudo
// jobs.mjs
async function createTask(db, taskData):
    threadId = taskData.threadId
    using sameClient transaction:
        taskId = await client.insert("tasks", {...taskData, status: "queued"})
        await client.upsert("outbox", {
            thread_id: threadId,   // outbox 以 Thread 为键，不是 taskId
            generation: nextGeneration,
            due_at: now()
        })
    // 事务提交后才返回"已接收"
    return taskId
```

### Redis 投递与 PG 兜底

```pseudo
// queue.mjs — 投递侧
async function deliverPendingTasks():
    rows = await pg.query(
        "SELECT thread_id FROM outbox WHERE due_at <= now() AND ..."
    )
    for row in rows:
        try:
            await redis.SADD("wake_threads", row.thread_id)
            await pg.query(
                "UPDATE outbox SET due_at = now()+5s WHERE thread_id=$1",
                [row.thread_id]
            )
        catch RedisError:
            // 只标进程 healthy=false，不更新 PG outbox（outbox 无 healthy 列）
            process.healthy = false
            scheduleRetryWithDelay()
            // 已落 PG，不丢；恢复后从 outbox 补投

// 消费者侧（每200ms）
async function consumeWakeQueue():
    // 原子弹出，不用 SMEMBERS+DEL（后者有丢消息风险）
    threadIds = await redis.SPOP("wake_threads", 50)
    for threadId in threadIds:
        serialize(threadId):
            if threadPaused() or activeTurnPreventsDispatch(): continue
            // 显式追加优先；普通消息按数据库 sequence 先进先出
            selected = chooseOneEligibleTask(threadId)
            if not selected: continue
            claimed = pg.updateTask(
                id=selected.id, expectedStatus="queued",
                newStatus=selected.requiresSteer ? "steering" : "starting"
            )
            if claimed: dispatchExactlyThisTask(selected)
        // 只领取一个任务；这里不是重写 Codex 的 Agent loop
```

### 写文件带来源声明（真实顺序）

```pseudo
// resources.mjs + files.mjs
async function writeFileWithProvenance(db, path, content, sourceVersions):
    // 1. 校验参数、路径、大小；校验来源版本 ready
    validate(path, content)
    for sv in sourceVersions:
        assertReady(db, sv.versionId)   // resource_versions 无 state 列，校验 resources.state

    // 2. 先写不可变 blob 快照
    blobPath = ".data/files/objects/" + sha256(content) + ".txt"
    if not exists(blobPath):
        writeFileCreateOnly(blobPath, content)

    // 3. PG 事务：预留 pending + 期望版本 + 依赖关系
    {resourceId, versionId} = await db.transaction(() => {
        insertPendingResource(path, expectedHash, sourceVersions)
    })

    // 4. create-only 写 workspace 指定文件
    writeFileCreateOnly(workspacePath(path), content)

    // 5. PG 核验状态与来源后标 ready（resources.state 更新，current_version 指向新 versionId）
    await db.markReady(resourceId, versionId, actualHash)

    return {resourceId, versionId}
    // 崩溃会留下孤立 blob 或 pending，均保留，不自动清理
```

---

## 安装与运行

### 环境要求

以下命令在项目目录执行；若运行 s04，改为进入它自己的目录。已有 `.env` 请保留，只补充数据库配置。

```bash
cd app
npm ci
```

- Node.js 24+，`npm ci` 安装依赖
- PostgreSQL 16 + Redis 7.4（本机二进制或 Docker）

PG 和 Redis 必须在 Codex 启动之前可连接，否则服务报错退出。

### 方案 A：本机已有 postgres/redis-server

```bash
# 新建临时集群，不读 .env，不连真实数据库
npm run test:data
```

### 方案 B：Docker Compose（开发用）

需先自行启动 Docker Desktop 或 Colima，当前环境中 Docker 守护进程未在线，文档不替你启动系统服务。

```bash
export AGENT_DB_PASSWORD='你自己设置的强密码'
docker compose up -d
```

编辑 `.env` 文件，**手动添加以下两行**（尖括号内容为占位说明，不要直接粘贴运行）：

```dotenv
DATABASE_URL=postgresql://agent:<URL编码后的密码>@127.0.0.1:5432/agent
REDIS_URL=redis://127.0.0.1:6379/0
```

> 如果密码含特殊字符，需对密码部分做 percent-encoding（如 `@` → `%40`）。

不要运行 `docker compose down -v`，这会删除数据库 volume。安全停止用 `docker compose down`（保留 named volumes）。

```bash
# 建表与校验（app 目录）
npm run data:migrate   # 显式建表，仅此命令才执行 migration
npm run data:check     # 确认 PG + Redis 连通，不访问模型

# 启动服务（按各自 .env 模板：app 4317，s04 4314）
npm run server         # 后端
npm start              # 在另一个终端执行：CLI 客户端
```

`app/` 和 `s04-data-layer/` 可共享同一组 PG/Redis，但不要各自启动独立 Compose 争抢 5432/6379 端口。各目录分别执行 `data:migrate`/`data:check`，instanceId 自动独立。

已运行的服务请先停止并备份，再执行迁移；不要在运行中服务上自动迁移。

---

## 数据迁移

本次对现有 `project` 做了只读预检：23 条旧任务中，17 条缺少会话／Agent 版本绑定，严格导入因此拒绝继续；没有修改或导入这些旧数据。当前环境也尚未配置 `DATABASE_URL` / `REDIS_URL`。正式切换前，需要先决定无绑定历史的保留策略并配置存储服务；下方命令不是“存量迁移已经成功”的记录。

### 从旧 JSON 迁移

执行前务必完整备份：`workspace/`、`.data/`（含 Codex 原生存储、identity、files、旧 JSON）、`agents/` 目录；数据库已有数据还需 `pg_dump`。

```bash
# 第一步：停止服务

# 第二步：预检（不导入业务任务，先校验旧文件与绑定）
# 注意：脚本可能初始化 identity/local-owner，不是绝对零写入
npm run data:import

# 第三步：确认 counts 无误后正式导入（全事务，可重入，原件不变）
npm run data:import -- --apply
```

导入说明：

- 预检主要验证源文件关系，**不导入任务**；缺合法绑定的记录不猜测接管
- 首次导入的会话设为 `paused`；重复导入不重置数据库已有状态
- `running` 任务转为 `unconfirmed`（受理结果不明确），明确 failed/interrupted 不转 unconfirmed
- 旧 descriptor 与新代码 hash 可能不兼容，导入不等于旧 Thread 可继续；推荐 `/new` 新建会话，旧原生历史仍保留
- 服务检测到旧 JSON 存在但无 `imports` 标记时，会阻止启动，防止静默遗漏历史

### 文件重命名（relocate）

```bash
# 用户需先停服、手动移动实际文件，再执行：
node scripts/data.mjs relocate '替换为真实的资源UUID' 'outputs/新文件名.md'
# 脚本验证内容 hash 一致才更新位置；原 resourceId/versionId 保留
```

脚本不替用户执行文件移动。

### 数据修复

```bash
# pending 状态修复（按实际文件 hash 核对，恢复 ready 或标 unconfirmed，不盲目覆盖）
node scripts/data.mjs reconcile

# 资源撤销（立即标 revoked，派生资源标 stale）
node scripts/data.mjs revoke '替换为真实的资源UUID'
```

---

## 测试覆盖

### 测试命令与覆盖范围

| 命令 | 覆盖内容 |
|---|---|
| `npm test` | 单元/集成测试，project 和 s04 均已通过，具体数目以最终验收输出为准 |
| `npm run test:data` | 真实 PG/Redis/Codex/MCP/文件链路，新建临时集群、随机回环端口、不读 `.env`；含外部更新/删除按需失效、Redis 故障注入补投、JSON 迁移预检/幂等/冲突回滚 |
| `npm run test:codex-tools` | Codex 工具，使用显式 test double 替代真实存储，不证明 PG 链路 |
| `npm run test:codex-memory` | 原生记忆，原生合并功能仍 blocked |

`test:data` 使用临时集群，成功后自动清理；失败则保留日志供排查。PostgreSQL test trust 模式仅限临时回环，不是部署配置。

`test:data` 为本机模拟，不声称真实网络断网演练，无真实 DeepSeek 端到端，无真实存量导入验收。

演进目录的 `node verify.mjs --integration` 会执行 s01 至 s05 的测试及 s04 / s05 数据集成验收；需要本机提供 `initdb`、`pg_ctl`、`redis-server`。最近结果见演进目录的 `verification.json`，不把历史报告当成这次运行结果。

---

## 方案审查与对抗审查

### 本期能力边界

| 维度 | 本期已做 | 暂缓/未做 |
|---|---|---|
| 持久化 | PG 保存业务状态、任务输入、资源版本、偏好、通知终态 | 聊天正文全文搜索（仍原生）|
| 调度 | outbox + Redis Set + CAS claim，重启可从 PG 补投 | 分布式多 worker |
| 资源追踪 | resourceId/versionId/revision，按需失效传播 | Wiki 后台生成、自动索引构建、向量 RAG |
| 来源声明 | write_file source_versions 可选登记 | 自动捕获所有依赖 |
| 身份 | instanceId/ownerId 应用层隔离 | 账号注册/密码登录/Redis 登录态（另期设计）|
| 多用户安全 | 资源归属校验（owner/instance）| DB RLS、OS 级隔离、多用户执行环境独立（另期设计）|
| 外部连接器 | 本期未接入 | 外部订单等继续保持原系统权威（另期接入）|
| 原生记忆生成 | 测试用例存在 | 功能仍 blocked，非本期验收 |

### 风险、实际处理与尚存边界

| 风险 | 实际处理 | 尚存边界 |
|---|---|---|
| 文件与数据库只成功一部分 | 未登记 blob 保留；已预留 pending 可用 `reconcile` 核对 | 无跨介质原子事务；脚本不能自动找回未登记 blob 的业务归属 |
| Redis 投递异常 | 进程标 healthy=false，outbox 保留，恢复后补投 | 健康时按约 5 秒重投周期检查；故障持续时间不设伪造上限 |
| 消费者 SPOP 后崩溃 | outbox 已延后 due_at；任务仍 queued 则到期补投，已 starting 则重启转 unconfirmed | 重复投递由 PG 条件领取防重；结果不明不自动重跑 |
| advisory lock 丢失 | heartbeat 专用连接检测到断开，立即停调度并关闭 Codex | 合作式锁，DB 管理员可绕过 |
| 旧数据导入不兼容 | 导入设 paused，unconfirmed 需人工核查，不自动继续 | 旧会话可能与新代码 hash 不兼容，需 /new |
| 孤立 blob 积累 | 保留不删；`reconcile` 只处理已登记 pending | 未登记 blob 需要另行盘点，不提供自动垃圾回收 |
| 多用户/多租户访问 | 当前仅单用户 local-owner，应用层 owner 校验 | 多用户安全、RLS、账号体系均另期设计 |
| 索引/Wiki/RAG | 文件版本与声明依赖可供后续复用 | 尚无检索后端或索引构建任务 |

### 数据备份分类

需定期备份（丢失不可恢复）：

- PG 数据库（`pg_dump`）
- `workspace/`
- `.data/identity.json`
- `.data/files/`（不可变 blob）
- `.data/codex/`（Codex 原生存储）
- 权威配置：`agents/`（含 `agents/roles/`）、`config/tools/`、配置绑定的实际 Skill 文件

可从 PG 重建或按既有规则清理：

- Redis 调度队列（可从 outbox 重建）
- `.runs/`（最新 5 个和 7 天内受保护，其余可清理）

未登记的孤立 blob 不可擅自清理，需另行核对归属；`reconcile` 只核对数据库里已有的 pending 写入。备份策略需读者自行配置，本文档不承诺已自动实施备份。

启动前请确认：`.env` 中 `DATABASE_URL`/`REDIS_URL` 指向正确实例，工作区和 `.data/identity.json` 未被意外改动。

---

## 安全边界与旧兼容层

当前仍是本机单用户服务：`users` 只登记 local-owner，没有密码登录、Redis 登录 Session 或数据库 RLS。Compose 中的 PG 用户是本地引导管理员，Redis 无认证且只映射回环端口；不能直接当成公网生产配置。数据库超级管理员、同 OS 用户或恶意工具模块不受应用层范围检查保护。

`DATABASE_URL`、`REDIS_URL`、`AGENT_DB_PASSWORD`、`REDIS_PASSWORD` 和 `PG*` 凭据不传给 Codex。`GET/POST /preferences` 保存显式偏好，但返回 `injectedIntoContext: false`，不自动拼入 prompt。原生长期记忆完整生成链路仍未验收；通知目前只记录任务终态，不包含推送中心。

本次代码升级没有改动用户真实 `.env`、存量 workspace 或 Codex 历史，也没有代替用户执行存量导入、启动长期数据库服务或配置自动备份。

### 旧兼容层

- `05` 单文件旧 demo 保留，不用于证明新 PG 主链路
- 旧 `session-index.json` 仍是历史兼容索引和清理保护依据，不是生产业务会话权威
- 旧 `messages.json`/`thread-agents.json`/`agent-descriptors` 生产不再写入，仅显式 `data:import` 保留原件
