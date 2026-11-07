# s12: 部署单元——让 Agent 在服务器上持续工作

[导论](../introduction.md) · [s11](../s11-model-gateway/README.md) → `s12` → `s13`

全仓入口：[机制课堂](../../app/web/public/course/index.html#s12) · [阶段演示](../../app/web/public/course/changes.html#s12) · [章节长文](../../app/web/public/course/handbook.html#module-s12) · [总架构图](../../app/web/public/course/assets/s12-architecture.svg)

> **对应六个问题**：③ 之前聊过什么？持久化原生历史与备份；⑤ 能用什么？交付明确的容器运行环境；⑥ 谁说了算？入口、并发、关闭与恢复由部署边界约束。

## 要回答的问题

本机能跑的 Agent，如何交给另一台机器长期运行？服务退出之后谁启动它，数据是否还在，模型网关故障时是否还能接任务，出错后能否退回上一版？

本章只有一个新单元：部署。沿用已有的 Agent、工具、知识、工作流和模型网关，不引入账号、多主机或自动发布流水线。

## 核心概念

| 五个问题 | 本章的回答 |
| --- | --- |
| 交付什么 | 固定 Node 版本和 digest 的镜像，锁文件 `npm ci --omit=dev`，node 非 root 用户；安装 lsof、bubblewrap。数据库备份在宿主机通过 postgres 容器执行。支持 NPM_REGISTRY/APT_MIRROR。 |
| 数据放哪 | PostgreSQL/Redis 用独立数据卷；`.data`、`.runs`、`workspace`、`backups` 挂载宿主目录。代码与数据分离。 |
| 密钥放哪 | 宿主 `.env` 权限 600；Compose 按服务列出变量。agent 只拿网关访问密钥和自身数据库凭据，gateway 持有服务商密钥与验证调用者所需的网关密钥。 |
| 谁启动、谁重启 | systemd 开机执行 Compose；每个服务 `restart: unless-stopped`、`stop_grace_period: 30s`，依赖健康后才启动后续服务。 |
| 谁能进来 | 只发布 `127.0.0.1:4326`，其余三个服务没有宿主端口。客户端通过 SSH 隧道进入。 |

**固定路径是持久化契约。** `CONTAINER_APP_DIR` 必须等于宿主部署路径。本机体验用当前目录的绝对路径，服务器默认部署位置见 remote.sh。Codex 原生历史保存绝对路径；更换路径后旧会话无法直接恢复。回滚在固定路径替换代码，不改成带时间戳的容器工作目录。若迁移已有历史，连同原路径保持一致；本章不实现跨路径历史改写。

### 中间件也用容器封装

PostgreSQL、Redis、模型网关在本阶段都以容器方式运行，写在同一份 `compose.yaml` 里。服务名是 `postgres`、`redis`、`gateway`：`postgres` 把数据放进命名卷 `postgres-data`（容器内 `/var/lib/postgresql/data`），`redis` 放进 `redis-data`（容器内 `/data`）。好处是版本固定、数据卷外置、随服务一起启停。

图片与视频这类大文件，生产环境通常放对象存储桶，可以用 MinIO 等 S3 兼容服务同样以容器运行。本教程里生成的文件仍放在 `workspace`。文件量大、要多台机器共享、或要直接给前端下载时，再换成存储桶。

`/health` 只表明 HTTP 进程存活，返回 `alive`；`/ready` 检查数据库、网关健康、已加载模型目录，并检查调度状态，不能接任务时返回 503。两个接口都返回 `version`，读取 REVISION，没有文件时为 `dev`。它们不需连接令牌、不计入请求限流，也不暴露连接凭据。

全局最多同时执行 **2** 个轮次，多余任务按数据库顺序排队；全局最多 **200** 条 queued，单会话仍是 **100**。超过容量返回 `429 QUEUE_FULL`。已有轮次的追加不新增并发轮次；仍沿用已有会话内追加优先语义。暂停的会话和预算不足的任务不阻塞其他可执行会话。

按“连接令牌 + 实际来源地址”每分钟最多 **120** 次 HTTP 请求，超出返回 429 与 `Retry-After` 秒数。无效令牌合并到同一来源桶，防止换令牌绕过。全局 SSE 最多 **20** 个，预留名额发生在异步读取会话之前，断开后释放。四个默认值分别可用 AGENT_MAX_CONCURRENT_TURNS、AGENT_MAX_QUEUED、AGENT_RATE_LIMIT_PER_MINUTE、AGENT_MAX_SSE 覆盖。

每个服务轮转 json-file 日志，`max-size=10m`、`max-file=3`。内存默认 PostgreSQL **256m**、Redis **128m**、gateway **256m**、agent **768m**，通过对应 `*_MEMORY_LIMIT` 覆盖。镜像不带 `.env` 或运行数据；命令参数不携带密钥。网关配置只有环境变量引用，agent 通过不含密钥的服务商清单选择模型。

收到 SIGTERM，先停止派发，再把执行状态标为 `unconfirmed`（待核对），关闭连接，30 秒内结束；queued 保留且不自动重发不确定任务。启动失败尚未打开 HTTP 时，健康探测表现为连接失败。

备份与恢复由宿主机 Bash + docker compose 编排，不依赖宿主 Node/npm。备份时 agent 短暂停止：宿主通过 postgres 容器执行 pg_dump，gzip 写入 `backups/.<时间>.partial/database.sql.gz`；再启动一次性 agent 容器，用镜像内的 Node 打包 workspace、`.data/codex`、实例身份与不可变文件正文，生成含大小、SHA-256 和版本的 manifest，原子改名后只保留最近 **7** 份。退出 trap 尝试重启 agent。下载使用 SSH + rsync，限速 **200 KB/s**；备份、恢复和下载共用同一个 flock 文件锁，冲突立即拒绝。备份不经 HTTP 提供。

## 分工：Codex 做什么，我们做什么

Codex 继续执行模型轮次并维护原生历史。部署代码负责容器、就绪检查、队列容量、入口限流、关闭与备份，不重新实现 SDK 或数据库驱动。

我们提供可用的模型密钥与服务器，确认固定目录、数据盘与备份位置，运行外部 Docker/服务器验收；面对待核对任务先查看结果，不直接重发。回滚只恢复代码和镜像，不会倒转数据库或工作区内容。破坏性数据库迁移需要恢复升级前备份，本章不自动降级 schema。

## 跑起来看看

本机需要 Node.js 24+、Docker Engine 或 Docker Desktop、Compose v2。先进入本阶段目录：

```bash
npm ci
cp .env.example .env
npm run gateway:key
```

编辑 `.env`：填写一家服务商密钥，选择对应 CODEX_MODEL，AGENT_DB_PASSWORD 填随机十六进制密码（避免 URI 特殊字符），CONTAINER_APP_DIR 填 `pwd` 的结果。文件设置权限 `chmod 600 .env`。这些实际值只保存在你本机，不放进文档或提交。

```bash
docker compose build agent
bash deploy/configure.sh
docker compose up -d --wait postgres redis gateway
docker compose run --rm --no-deps -T agent npm run data:migrate
docker compose run --rm --no-deps -T agent npm run agent:init
docker compose up -d --wait agent
curl --fail http://127.0.0.1:4326/ready
```

预期 JSON 的 `status` 为 `ready`、`version` 为 `dev`，三个 checks 均为 true。Linux bind mount 若权限不匹配，先由管理员把 `.data`、`.runs`、`workspace`、`backups` 交给 uid 1000；`sudo bash deploy/configure.sh` 会做此初始化。本机 CLI 可运行 `npm run chat`，它读取挂载回宿主的 `.data/connection.json`。服务停止可用 `docker compose stop`，不要使用 `down -v` 删除数据卷。

离线实验不需要 Docker、网络或监听端口：

```bash
npm run test:deploy
npm run lesson -- list
npm run lesson -- s12-health
npm run lesson -- s12-queue
npm run lesson -- s12-protection
npm run lesson -- s12-backup
```

部署到一台使用 systemd 的 Linux 服务器。准备 Docker、Compose、rsync、flock、tar、gzip、sha256sum；SSH 用户需要管理 Docker 和安装 systemd 单元的权限。脚本教学默认使用具备 root 权限的 SSH 登录，主机名可用 SSH 配置别名。迁移和初始化仍在 agent 容器内执行。宿主运行时只需 Docker 与 Compose，不需要 Node/npm；Bash、flock、gzip/gunzip 等系统工具仍需可用。

```bash
export DEPLOY_HOST=example.com
bash deploy/remote.sh check
bash deploy/remote.sh init-env
bash deploy/remote.sh deploy
bash deploy/remote.sh status
bash deploy/remote.sh tunnel
```

`init-env` 用 Dockerfile 中固定版本的 Node 容器从本阶段 `.env` 取模型配置，经 SSH 写入服务器，重新生成数据库密码与网关密钥，已有文件拒绝覆盖。`deploy` 交付当前工作区，REVISION 包含 Git 基准短哈希与工作区部署时间；不执行 Git 提交。服务器保留上一版目录和 `previous` 镜像标签。首次部署没有上一版可回滚。

隧道在前台运行。在另一个终端用 curl 检查本机 4326 的 `/ready`；业务调用仍需要服务器 `.data/connection.json` 中的连接令牌。可用 SSH 把该 JSON 保存到本机私有文件供 CLI 读取，或设置 AGENT_SERVER_URL 与 AGENT_SERVER_TOKEN 环境变量；令牌不要写进进程参数或终端日志。不要覆盖本机正在使用的连接文件。本机若已有体验容器占用 4326，先停止它再开隧道。

```bash
bash deploy/remote.sh backup
bash deploy/remote.sh backup-download
# 也可以指定服务器输出的备份目录名
bash deploy/remote.sh backup-download 2026-01-01T00-00-00-000Z
bash deploy/remote.sh rollback
```

### 备份与下载

下载到运行命令时的 `./backups/`。manifest 可按 SHA-256 校验。备份、恢复和实际 rsync sender 全程持有 `backups/.download.lock` 的排他 flock，冲突退出码为 75，不排队。进程退出后内核自动释放锁；锁文件留在原处，不要删除它。

服务器直接运行以下 Bash 入口，无需安装 Node/npm：

```bash
bash deploy/backup.sh
# 将名称替换为备份输出的目录名
bash deploy/restore.sh 2026-01-01T00-00-00-000Z
# 无交互终端时必须显式确认覆盖
bash deploy/restore.sh 2026-01-01T00-00-00-000Z --yes
```

`remote.sh backup` 调用同一个 `deploy/backup.sh`。已有 npm 的开发机也可使用 `npm run backup` / `npm run restore -- <名称> [--yes]`，它们只是 Bash 入口的别名。备份先取锁、停止 agent，再运行 `docker compose exec -T postgres pg_dump --no-password -U agent --clean --if-exists --no-owner --no-privileges agent_s12`，gzip 写入 partial 目录。随后 `docker compose run --rm --no-deps -T agent node scripts/backup.mjs --apply --partial <名称>` 完成打包、manifest、改名和保留最近 7 份。无论成功失败，trap 都尝试 `docker compose up -d --wait agent`；失败的 partial 会清理。

恢复先取锁、停止 agent，再从 `/dev/tty` 读取 `RESTORE` 确认；非交互且没有 `--yes` 会拒绝。一次性 agent 容器执行 `restore.mjs --verify <名称>`，校验通过后宿主用 `gunzip -c | docker compose exec -T postgres psql` 重放纯 SQL（`ON_ERROR_STOP=1`、单事务），再由 `restore.mjs --files <名称>` 恢复目录。最后启动 agent 并检查 `/ready`。取消或任一步失败都会保持 agent 停止；就绪检查失败也会再次停服并提示。修复后重新执行完整恢复。

postgres 容器需保持运行；agent 镜像须先构建。Compose 的 `.data`、`workspace`、`backups` 挂载同时用于服务和一次性容器，目录须对 uid 1000 可写。服务器 root 创建的 partial 与 SQL 文件会交给 uid 1000；非 root 执行用户须具备对应目录权限。先保留当前数据的备份；恢复仅接受受信任备份，manifest 校验不是数字签名。

完整的外部验收见 [验收步骤与交付差异](delivery.md)。域名、HTTPS、Basic 口令与路径白名单见 [生产示例](docs/production.md)，不属于教学启动步骤。

## 关键代码

`server/modules/deployment/index.mjs` 的四个默认值由同一配置函数校验：

```javascript
    maxConcurrentTurns: integer('AGENT_MAX_CONCURRENT_TURNS', 2),
    maxQueued: integer('AGENT_MAX_QUEUED', 200),
    rateLimit: integer('AGENT_RATE_LIMIT_PER_MINUTE', 120),
    maxSse: integer('AGENT_MAX_SSE', 20),
```

`server/modules/data/jobs.mjs` 在事务内先锁定实例，再检查全局与会话容量，所有进入 queued 的路径使用同一个门禁：

```javascript
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 12))", [this.instanceId]);
```

关闭入口的顺序对应“先停止派发，再保存不确定状态，最后清理”：

```javascript
    stopDispatch();
    const deadline = timer(() => exit(1), 30000);
    try { await markUnconfirmed(); await close(); }
    finally { clear(deadline); }
```

## 小结

部署把代码、数据、凭据和进程管理的责任明确下来。就绪探测决定当前是否能接任务，容量限制决定能接多少，持久化状态决定重启后哪些任务可以继续，备份和固定路径保证原生历史有恢复基础。

## 下一章

s13 账号与认证：把当前单一连接令牌扩展为明确的用户身份与授权关系。本章的共享访问口令与来源限流不等于用户系统。
