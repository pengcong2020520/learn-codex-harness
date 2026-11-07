# 部署单元设计

## 设计原理

运行环境可重复交付，持久化数据独立于镜像；部署路径是 Codex 原生历史的外部契约。HTTP 存活与业务就绪分别判断；数据层容量限制与执行器并发限制分别负责“接多少”和“做多少”。失败保留确定事实，不猜测模型是否已经完成外部操作。

## 架构改进

四个服务：postgres → gateway → agent，所有依赖使用 service_healthy，agent 也等待 Redis 健康。gateway 仍使用 Bifrost 的环境变量引用配置；配置生成时另写服务商名称列表供 agent 使用，避免通过传递服务商密钥来判断模型可用性。

PostgreSQL/Redis 使用命名卷，正文、原生历史与运行记录挂载宿主目录。只有 agent 发布宿主回环端口。systemd 负责开机启动整个 Compose，Docker restart policy 负责退出后重启。unhealthy 本身不会触发 Docker 自动重启，依赖条件也只影响启动，不持续重排服务。

## 技术实现流程

1. 构建固定 Node 镜像，按锁文件安装既有 npm 依赖；生成不含密钥的网关配置。
2. 启动并等待数据库和网关；停 agent 后执行既有数据迁移和 Agent 初始化，再启动 agent。
3. HTTP /health 返回存活；/ready 在有限超时内检查数据库和网关，同时核对模型目录、队列与执行器状态。
4. 任务创建、确认与工作流再排队在 PostgreSQL 事务里争用同一实例锁，检查 queued 计数。全局串行扫描按 tasks.sequence 排序，并保留会话内既有追加优先语义；新轮次启动前检查正在执行的会话数，不超过 2。
5. HTTP 入口使用 60 秒滑动窗口，以令牌和 socket peer 为键；健康接口绕过，SSE 先占位再等待业务读取，close 释放。
6. SIGTERM 同步停止派发、持久化 unconfirmed、关闭 HTTP/SSE/RPC/数据资源，30 秒截止。重启由原有 recover 处理残余 starting/running/steering，queued 不丢失。
7. 备份与恢复由宿主 Bash + docker compose 编排；宿主运行时只需 Docker 与 Compose，不需要 Node/npm，系统需提供 Bash、flock、gzip/gunzip。Agent 镜像仍只额外安装 lsof 与 bubblewrap，不安装 postgresql-client。`deploy/backup.sh` 先取共享 flock，再停止 agent，使数据库与目录保持一致；退出 trap 保证尝试 `docker compose up -d --wait agent`。宿主调用 postgres 容器里的 pg_dump，参数与 `backup-lib.mjs` 的 dumpCommand 一致，经 gzip 流写入 `backups/.<名称>.partial/database.sql.gz`。接着 `docker compose run --rm --no-deps -T agent node scripts/backup.mjs --apply --partial <名称>` 使用镜像内 Node 与 tar 打包、计算 manifest，原子重命名，只保留最近 7 份成功备份。partial 不存在或缺少 SQL 时拒绝发布。宿主 root 创建的 partial 和 SQL 文件交给 uid 1000；Compose 已挂载 backups、workspace 和 .data，一次性容器可读写同一数据。
8. `deploy/restore.sh <名称> [--yes]` 持同一锁，先停 agent，再读 `/dev/tty` 确认；非交互且没有 `--yes` 时拒绝。一次性 agent 容器的 `restore.mjs --verify <名称>` 校验 manifest 后，宿主用 `gunzip -c | docker compose exec -T postgres psql` 重放 gzip 纯 SQL，参数与 psqlCommand 一致（单事务、ON_ERROR_STOP=1）。随后容器的 `restore.mjs --files <名称>` 恢复目录，保留 bind mount 根目录；启动 agent 并检查 `/ready`。取消或任何步骤失败都保持 agent 停止；启动或就绪失败也再次停止，避免继续提供混合数据。
9. 下载实际 rsync sender 与备份、恢复共用 `backups/.download.lock` 的非阻塞 flock；争用失败立即返回 75，锁在操作全程持有，进程退出自动释放。锁文件不删除，避免 inode 更换破坏互斥。远程 `remote.sh backup` 调用 Bash 入口；package.json 的 backup/restore 仅供已有 npm 的开发机便捷调用。远程版本回滚使用上一版代码与镜像，数据目录保持原路径。

## 核心代码

以下为伪代码，不是新的模型执行框架。

```text
接收任务：
  begin
  lock(instance queue capacity)
  if queued_total >= 200 or queued_in_thread >= 100: 429 QUEUE_FULL
  persist task + outbox
  commit

调度：
  serial global scan of queued tasks ordered by sequence
  preserve per-thread execution boundary and append semantics
  if active_turns >= 2: leave queued
  else mark starting; call existing Codex turn/start

停止：
  stop dispatch immediately
  recover executing -> unconfirmed
  close connections
  force exit at 30 seconds if resources hang
```

## 验证

`npm run test:deploy` 是无 Docker、无监听端口的测试，覆盖真实 HTTP handler、仓储容量门禁、真实消息调度、关闭顺序、容器 CLI 的真实 tar 打包、manifest 摘要/保留策略、篡改拒绝、Bash 编排成功与失败路径，以及部署静态约束。测试夹具不替代运行时库。Linux 可额外运行 `node --test tests/deploy-lock.integration.mjs` 检查真实 flock，rsync 仅用阻塞夹具代替传输。

外部 `npm run test:deploy:integration` 检查真实 Compose 资源配置以及网关停止时 /ready=503、/health=200。此测试要求已配置模型环境并初始化数据库；不等于验证真实模型质量。数据库排队事务竞争、真实备份恢复、SIGTERM 与回滚验收见 [交付验收](../delivery.md)。本阶段已登记到 [全仓验证](../../verify.mjs)，统一检查章节标题、链接与源码摘录。

## 限制说明

单进程 HTTP 限流，重启会清空；代理后按代理的实际地址计数。无账号、多主机、Kubernetes、监控告警或自动化 CI/CD。对象存储未接入。模型目录已加载与 gateway 健康不证明供应商额度足够或模型一定响应。Redis 不可用时 /ready 返回 503，数据库仍保存任务。

容量针对 queued，不把等待确认或提议计入。已有轮次的追加不另占执行名额。保持会话内原有追加优先逻辑，因此跨会话按最早可执行队列顺序扫描，不承诺严格阻塞所有会话的单一总 FIFO。工作流自动进入下一步若遇队列已满，会停在等待确认，容量释放后由用户确认；不会超额排队。

执行器依赖 PostgreSQL 独占锁。本阶段不改 SDK 内部行为，容量只限制服务派发的对话轮次，不限制模型工具自身的内部并行。30 秒内无法落库时由启动恢复将残留执行状态标为待核对。

备份停机且不包含镜像、Redis 缓存、`.runs` 日志或服务商密钥。须另行妥善保管 `.env` 和可用代码镜像。pg_dump 与 psql 使用正在运行的 postgres:16 容器，备份文件是 gzip 纯 SQL。state.tar.gz 保存实例身份和不可变文件正文；知识索引缓存可重建。本章恢复需要相同部署路径，数据库 schema 必须兼容。恢复过程不是跨数据库和文件系统的原子事务，失败时保持停服，再恢复完整备份。只接受管理员信任的备份包；SHA-256 用于发现损坏，不认证来源。

上一版是代码和镜像，不包含 `.env` 的历史版本；数据库不自动回滚。失败部署保留 pending 标记，下一次部署前先处理回滚。首次部署失败没有上一版，应排除问题、确认没有部署进程后清除 pending 标记再重试。备份、恢复与下载的 flock 在进程退出后自动释放；无需清理锁文件。

## 机制实验

[实验目录](../lessons/README.md) 提供就绪与存活、全局容量、HTTP 防护、备份保留四组离线实验。每组说明问题、预期、证据与边界。外部验收单独列出，没有运行的检查明确记为未验证。
