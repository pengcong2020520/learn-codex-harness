# s16：协调面

对应六个问题：⑥ 谁说了算

## 要回答的问题

三个节点怎样判断成员还活着、谁可以服务？旧 control 暂停后醒来，为什么不能继续写协调信息？本章只增加 coordination 单元，保留用户 uid、独立进程与 CODEX_HOME 隔离，以及 Hub 的资源授权、权益和审计。

## 核心概念

租约是存活的确定性判断：节点是否仍属于集群，以 etcd 中 TTL 10 秒的 lease 是否有效为准，不根据一次 ping 猜测进程状态。etcd3 自动按 TTL/3 发送 KeepAlive；成员键与选举键绑定同一个 lease。租约到期，etcd 删除这些键；正常退出主动撤销，无需等到期。

Watch 先整前缀读取并记录 revision，再从 revision + 1 接收增量。普通断线由 etcd3 从已交付 revision 续读；历史被压缩时重新读全表，重建缓存。revision 用字符串和 BigInt 计算，避免大整数精度丢失。

Election 决定谁是 control。任期等于该节点选举键的 create revision，是单调增长的隔离令牌。`guardedPut` 用事务比较旧选举键的 create revision；键已经删除或重建时，旧任期写入返回 409 `NOT_CONTROLLER`。`/codex/cluster/info` 的成员数、任期和时间是这个机制的演示。

自我隔离先同步关闭接收入口和派发开关：lease 丢失，或自上次成功 KeepAlive 起超过 TTL，立即使 `/ready` 返回 503。随后把本代已经派发的轮次标为 `unconfirmed`（待核对），关闭 worker、用户进程池和业务连接。旧代的通知、数据库查询与事务提交不能因为后续当选而复活。暂停恢复时，每个入口也会检查单调时钟，不能只等定时器回调。

本章采用主备，因为还没有按用户分片。只有 control 启动完整业务栈、派发和 worker；两个热备不启动用户进程。新 control 先确认任期，再执行 s08 恢复：执行中的轮次待核对，不自动重发；queued 由持久 outbox 重新唤醒。恢复完成后才就绪。

三个容器共享 `.data`、`workspace`、`.runs`、`backups`，仅用于单机模拟。多机没有共享磁盘，s18 用副本解决；本章不实现分片、路由、复制或业务数据库 epoch。

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
# 填数据库、网关与模型配置；CONTAINER_APP_DIR 必须等于固定部署绝对路径。
npm ci
# 本机：先填三个节点独立数据库密码，再准备数据；服务器可直接用 remote.sh。
docker compose build node-a node-b node-c
bash deploy/configure.sh
docker compose up -d --wait postgres redis etcd gateway
docker compose run --rm --no-deps --user 0 -T -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/cluster-migrate.mjs
docker compose run --rm --no-deps node-a npm run agent:init
# 首次初始化，交互输入 admin 用户名与密码：
docker compose run --rm --no-deps node-a npm run auth:init
bash deploy/cluster-ready.sh
export AGENT_SERVER_URL=http://127.0.0.1:4334
npm run login
npm run cluster -- status
```

入口仅发布 `127.0.0.1:4334`，节点内部端口是 `4340–4342`，不占宿主 4330/4331。数据库 `agent_s16`，Compose 项目及 systemd 单元 `codex-harness-s16`，服务器目录 `APP_DIR=/opt/s16-coordination`，示例域名 `example.com`。CLI 经 Caddy 登录和查询；热备直连 `/ready` 返回 503，`/health` 返回 200。容器健康检查采用 `/health`，因此 `compose --wait` 不会把热备当故障；入口健康检查仍采用 `/ready`。

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
# 自我隔离后保持停服；显式重启以新 lease 作为普通候选成员加入。
docker compose restart node-a
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
ETCD_TEST_ENDPOINT=http://127.0.0.1:2379 npm run test:coordination
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
    const result = await this.client.if(this.electionKey, 'Create', '==', this.ownTerm)
      .then(this.client.put(key).value(typeof value === 'string' ? value : JSON.stringify(value))).commit();
    if (!result.succeeded) { this.isolate('stale-term'); throw notController(); }
    this.assertController();
  }
```

同步隔离后再交给关闭流程：

```javascript
  isolate(reason) {
    if (!this.alive && !this.controller) return;
    this.alive = false; this.controller = false;
    clearTimeout(this.timer);
    this.lease?.release(); // no more automatic renewals after local fencing
    this.record('isolated', { nodeId: this.nodeId, reason });
    this.emit('lost', reason); // synchronous admission/result fence before any await
  }
```

接口适配见 [etcd.mjs](server/modules/coordination/etcd.mjs)，切换见 [service.mjs](server/modules/coordination/service.mjs)，设计与边界见 [design.md](docs/design.md)。

## 限制

PostgreSQL、Redis、模型网关仍为单实例；etcd 教程也是单节点。control 高可用不代表这些依赖高可用。生产升级需三个独立故障域的 etcd 成员、TLS 与按 `/codex/` 授权、独立备份和监控；见 [生产部署](docs/production.md)。

etcd 的任期事务只隔离协调元数据，不能和 PostgreSQL、磁盘组成跨系统事务。本地门禁阻止隔离之后发起的结果写入，无法撤销隔离前已发送的数据库提交或外部工具副作用。容器假死恢复与网络分区需要外部故障验收。原生进程遵守 s14 关闭流程；本章不宣称提供 s18 的业务 epoch 或多机数据副本。

自动恢复只发生在新 control 上。已隔离节点保持 503，重启后使用新 lease 重新竞选；没有自动切回首选节点。事件环形缓冲随进程重启清空；诊断不是持久审计。故障期间 `/cluster` 也可能暂时不可用，可用 `docker compose logs` 与 etcdctl 核对。

## 小结

租约决定成员存活，Election 决定 control，create revision 隔离旧任期。Caddy 只向完成恢复的 control 转发，热备保留协调能力和接任资格。

下一章：s17 分片与路由。
