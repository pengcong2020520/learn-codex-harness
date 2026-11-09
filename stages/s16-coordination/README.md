# s16：协调面

[导论](../introduction.md) → [s00](../s00-sdk-quickstart/) → [s01](../s01-single-turn/) → [s02](../s02-multi-turn/) → [s03](../s03-service/) → [s04](../s04-events-messages/) → [s05](../s05-agent-assembly/) → [s06](../s06-tools/) → [s07](../s07-memory/) → [s08](../s08-data-layer/) → [s09](../s09-knowledge-layer/) → [s10](../s10-skill-workflow/) → [s11](../s11-model-gateway/) → [s12](../s12-deploy/) → [s13](../s13-auth/README.md) → [s14](../s14-isolation/README.md) → [s15](../s15-hub/README.md) → `s16` → [s17](../s17-sharding/README.md) → [s18](../s18-replication/README.md) → [app](../../app/)

对应六个问题：⑥ 谁说了算

## 要回答的问题

三个节点怎样判断成员还活着、谁可以服务？旧 control 暂停后醒来，为什么不能继续写协调信息？本章只增加 coordination 单元，保留用户 uid、独立进程与 CODEX_HOME 隔离，以及 Hub 的资源授权、权益和审计。

## 核心概念

租约是存活的确定性判断：节点是否仍属于集群，以 etcd 中 TTL 10 秒的 lease 是否有效为准，不根据一次 ping 猜测进程状态。etcd3 自动按 TTL/3 发送 KeepAlive；成员键与选举键绑定同一个 lease。租约到期，etcd 删除这些键；正常退出主动撤销，无需等到期。

Watch 先整前缀读取并记录 revision，再从 revision + 1 接收增量。每次（重新）连接后都整前缀重读并替换缓存；每 5 秒再核对成员与当前 control/任期，纠正差异并记录事件。压缩既检查 compact_revision 字段，也检查错误文本。revision 用字符串和 BigInt 计算，避免大整数精度丢失。

Election 决定谁是 control。任期等于该节点选举键的 create revision，是单调增长的隔离令牌。`guardedPut` 用事务比较旧选举键的 create revision；键已经删除或重建时，旧任期写入返回 409 `NOT_CONTROLLER`。`/codex/cluster/info` 的成员数、任期和时间是这个机制的演示。

自我隔离先同步关闭接收入口和派发开关：lease 丢失，或自上次成功 KeepAlive 起超过 TTL，立即使 `/ready` 返回 503。随后把本代已经派发的轮次标为 `unconfirmed`（待核对），关闭 worker、用户进程池和业务连接。旧代的通知、数据库查询与事务提交不能因为后续当选而复活。暂停恢复时，每个入口也会检查单调时钟，不能只等定时器回调。

本章采用主备，因为还没有按用户分片。只有 control 启动完整业务栈、派发和 worker；两个热备不启动用户进程。新 control 先确认 etcd 任期，再推进 PostgreSQL 的 `agent_data.cluster_term`，成功后才执行 s08 恢复：执行中的轮次待核对，不自动重发；queued 由持久 outbox 重新唤醒。恢复完成后才就绪。

三个容器共享 `.data`、`workspace`、`.runs`、`backups`，仅用于单机模拟。s17/s18 改为每节点独立磁盘；本章不实现分片、路由和复制。

## 分工

| 单元 | 职责 |
| --- | --- |
| coordination | lease、成员 Watch、Election、任期校验、主备生命周期、集群状态 |
| Caddy | 对三个节点执行 `health_uri /ready`，只转发到健康 control |
| messages / data | s08 的待核对、queued 恢复、PG 业务记录与 Redis 唤醒 |
| runtimes | s14 的四进程容量、每用户 uid / CODEX_HOME、关闭期限与隔离 |
| Hub | 资源可见性、分享、权益、配额、审计，在所有 control 上一致 |
| etcd | 只存 `/codex/` 下的协调元数据，不存业务会话和任务 |

代码版本从 `REVISION` 读取；成员同时报告 Agent 定义哈希、容量、地址和加入时间。节点名固定为 `AGENT_NODE_ID=node-a/b/c`，地址使用 Compose 服务名。`GET /cluster` 复用登录令牌且要求 admin，包含成员 lease 剩余 TTL、control 与任期、最近 20 条成员和选举事件。

## 跑起来看看

需要 Node.js ≥24、Docker Compose。三个 agent 默认各 768 MiB（`AGENT_MEMORY_LIMIT` 可覆盖），etcd 128 MiB、Caddy 64 MiB、PG 256 MiB、Redis 128 MiB、网关 256 MiB，容器上限合计约 3.1 GiB。服务器还需要系统、镜像构建和文件缓存余量，建议至少 4 GiB，实际模型和工作负载需要实测。

```bash
cd stages/s16-coordination
cp .env.example .env
# 填数据库、etcd root/health/三个节点、Redis、网关密码与模型配置。
# 服务器 remote.sh init-env 会随机生成这些密码并写服务器 .env（0600）。
# CONTAINER_APP_DIR 必须等于固定部署绝对路径。
npm ci
# 本机：先填三个节点独立数据库密码，再准备数据；服务器可直接用 remote.sh。
docker compose build node-a node-b node-c
bash deploy/configure.sh
docker compose up -d etcd
docker compose stop node-a node-b node-c
docker compose run --rm --no-deps -T etcd-init
docker compose up -d --wait etcd postgres redis gateway
docker compose run --rm --no-deps --user 0 -T -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/cluster-migrate.mjs
docker compose run --rm --no-deps node-a npm run agent:init
# 首次初始化，交互输入 admin 用户名与密码：
docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts init
docker compose up -d --wait node-a node-b node-c caddy
bash deploy/cluster-ready.sh
export AGENT_SERVER_URL=http://127.0.0.1:4334
npm run login
npm run cluster -- status
```

入口仅发布 `127.0.0.1:4334`，节点内部端口是 `4340–4342`，不占宿主 4330/4331。数据库 `agent_s16`，Compose 项目及 systemd 单元 `codex-harness-s16`，服务器目录 `APP_DIR=/opt/s16-coordination`，示例域名 `example.com`。CLI 经 Caddy 登录和查询；热备直连 `/ready` 返回 503，`/health` 返回 200。容器健康检查采用 `/health`，因此 `compose --wait` 不会把热备当故障；入口健康检查仍采用 `/ready`。

etcd 使用独立的 `health` 用户和同名角色，**只能读取精确的 `health` 键**，不能写入，也不能读取 `/codex/` 或其他键。`init-env` 随机生成 `ETCD_HEALTH_PASSWORD`，Compose 将其直接代入 `etcdctl --user health:… endpoint health`，不依赖镜像内的 shell。先启动 etcd（不等待健康），再运行 `etcd-init`，最后等待 etcd 和其余服务健康；初始化遇到连接失败会重试，最多 60 秒，并支持已有用户、角色及已开启认证的数据卷。

已有服务器升级时，保留 `.env` 中原有的 root、节点、数据库等密码，只补充随机的 `ETCD_HEALTH_PASSWORD`（例如用 `openssl rand -hex 24` 生成后写入 `.env`）。不要重新生成整份 `.env`。按上述流程或 `remote.sh deploy` 重新部署后，初始化脚本使用原 root 凭据补建 health 用户和角色，随后健康检查通过；数据卷无需删除，认证无需关闭。

`cluster status` 中的 `control.nodeId` 告诉你下一条命令该填写哪个节点。以下用 node-a 示意，每次故障前重新查询当前 control。

```bash
# 硬退出：成员约 TTL 10 秒后消失，另一节点当选；Caddy 切换后继续对话。
docker kill "$(docker compose ps -q node-a)"
npm run cluster -- status

# 假死：暂停旧 control 超过 TTL；恢复后旧任期不得写，入口仍指向新 control。
docker pause "$(docker compose ps -q node-a)"
sleep 15
docker unpause "$(docker compose ps -q node-a)"
npm run cluster -- status

# 正常退出：先关闭业务，再 resign / revoke，注册键立即消失。
docker stop "$(docker compose ps -q node-a)"
npm run cluster -- status

# 分区：对当前 control 执行，再接回；超过 TTL 自我隔离。
docker network disconnect codex-harness-s16_default "$(docker compose ps -q node-a)"
sleep 15
docker network connect codex-harness-s16_default "$(docker compose ps -q node-a)"
# 无需重启：旧服务和用户进程停止后，以新 lease 自动重新加入和竞选。
```

`restart: unless-stopped` 可能让 kill 后的节点自动回归；观察成员的 lease 和新任期，不把容器重启误当成原任期恢复。演示时先让三个节点都加入，再发会话请求；待核对轮次需人工查看历史，不自动重跑可能有副作用的工具。

```bash
npm test
npm run lesson -- list
npm run lesson -- lease
npm run lesson -- watch
npm run lesson -- election
npm run lesson -- fencing
npm run lesson -- isolation
# 独立、空的 etcd；不要指向正在运行的教学集群：
# 先对独立实例运行 scripts/etcd-init.mjs；不要复用业务集群。
# init 需要 ETCD_ENDPOINT、ETCD_ROOT_PASSWORD、ETCD_NODE_A/B/C_PASSWORD。
ETCD_TEST_ENDPOINT=http://127.0.0.1:2379 \
ETCD_TEST_NODE_A_PASSWORD="$ETCD_NODE_A_PASSWORD" \
ETCD_TEST_NODE_B_PASSWORD="$ETCD_NODE_B_PASSWORD" \
ETCD_TEST_NODE_C_PASSWORD="$ETCD_NODE_C_PASSWORD" npm run test:coordination
# 本机需 initdb、pg_ctl、redis-server；创建并清理独立临时数据库：
npm run test:data
# 预期：旧任期及缺任期写入 CT001；节点维护绕过 42501；新任期成功。
```

远程部署沿用 `DEPLOY_HOST=example.com bash deploy/remote.sh check|init-env|deploy|auth-init|status|tunnel`。备份、恢复与升级会停三个节点，不能只停 control 后让热备接手写盘。隧道本地端口为 4334，转发服务器 Caddy 回环入口。服务器首次部署流程需要安装 systemd；只在本机试跑可先按 `deploy/server-setup.sh` 的 Compose 步骤操作，跳过 `enable-service.sh`。

## 关键代码

注册键绑定自动续约的 lease：

```javascript
    const lease = this.client.lease(TTL); // automatic KeepAlive, TTL/3, owned by etcd3
```

任期保护写入：

```javascript
  async guardedPut(key, value) {
    this.assertController();
    const epoch = this.generation;
    const result = await this.client.if(this.electionKey, 'Create', '==', this.ownTerm)
      .then(this.client.put(key).value(typeof value === 'string' ? value : JSON.stringify(value))).commit();
    if (epoch !== this.generation) throw notController();
    if (!result.succeeded) { this.isolate('stale-term'); throw notController(); }
    this.assertController();
  }
```

同步隔离后再交给关闭流程：

```javascript
  isolate(reason) {
    if (!this.alive && !this.controller) return;
    this.alive = false; this.controller = false; this.generation++;
    clearInterval(this.reconcileTimer); clearTimeout(this.watchRetry);
    clearTimeout(this.timer);
    this.lease?.release(); // no more automatic renewals after local fencing
    this.record('isolated', { nodeId: this.nodeId, reason });
    this.emit('lost', reason); // synchronous admission/result fence before any await
  }
```

接口适配见 [etcd.mjs](server/modules/coordination/etcd.mjs)，切换见 [service.mjs](server/modules/coordination/service.mjs)，设计与边界见 [design.md](docs/design.md)。

## 限制

PostgreSQL、Redis、模型网关仍为单实例；etcd 教程也是单节点。control 高可用不代表这些依赖高可用。Compose 不发布 etcd 宿主端口；etcd 已开启认证，node-a/b/c 各有独立用户与角色，只允许 `/codex/` 前缀 readwrite。Redis 启用 requirepass。生产仍需独立故障域、TLS、备份和监控；见 [生产部署](docs/production.md)。网关密钥仍由三个节点共用，尚未按节点区分网关身份。

PostgreSQL 迁移 015 为 agent_data 下除 migrations、cluster_term 外的所有业务表建立 BEFORE INSERT/UPDATE/DELETE 触发器。连接包装器把独立语句也放入事务，执行 `SET LOCAL app.term`；触发器对任期行持有共享锁到事务结束，任期推进等待旧事务完成。新任期推进成功后，缺任期或旧任期写入返回 `CT001`，写入方立即隔离。推进只允许增加或保持当前值，遇到数据库更高任期也立即隔离。这里仍不提供 etcd、PG、外部工具之间的跨系统原子事务，不能撤销外部副作用。

运维命令明确使用 `app.maintenance=on`，触发器同时检查 `current_user` 必须为超级用户（部署中为 `agent`，临时集成测试为 `agent_test`）。PostgreSQL 自定义会话变量不能用普通 GRANT 禁止 SET；节点即使设置这个变量，业务写入仍被 42501 拒绝。节点角色无超级用户、建库、建角色权限，也不能直接写 cluster_term 或 migrations；只获准调用固定 search_path 的单调任期推进函数。账号初始化/修改、迁移和导入用一次性运维容器加载服务器 `.env`，长期节点只拿自己的 PG 与 etcd 凭据。新增业务表的后续迁移必须同时添加任期触发器。

`docker pause` 会冻结整个容器，包括用户 Codex 子进程；解冻后子进程会立即继续写共享卷。旧任期结果已被 PG 拦截，执行轮次由新 control 标为待核对，但文件写入不受数据库触发器保护。共享卷只用于单机模拟，s17/s18 改为每节点独立磁盘。本章不另做文件级锁。

`sharedLeaseElection` 依赖锁定的 etcd3 **1.1.2 内部调用顺序**：Campaign 构造时取得 namespace.lease，start 调用 grant，再以 lease ID 事务写入选举键。竞选错误和 resign 都可能撤销共享 lease，成员键也会随之消失。不能把这一适配当成稳定公开的 shared-lease API；升级依赖必须重跑认证集成测试。

隔离后不退出进程：等 service.stop 完成、用户 Codex 进程确认退出，再用新 lease join → Watch → campaign；失败按 2、4、8、16、30 秒指数退避，之后保持 30 秒。重新加入及新 control 恢复完成前 `/ready` 始终 503。旧 generation 的 lease、Watch、竞选和异步确认回调均失效。若无法确认旧进程退出，保持隔离，不创建新进程池。没有自动切回首选节点。事件缓冲不是持久审计，故障时可看容器日志与认证后的 etcdctl。

## 小结

租约决定成员存活，Election 决定 control，create revision 隔离旧任期。Caddy 只向完成恢复的 control 转发，热备保留协调能力和接任资格。

下一章：[s17 分片与路由](../s17-sharding/README.md)。
