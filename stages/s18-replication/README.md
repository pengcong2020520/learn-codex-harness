# s18：副本与故障接管

对应六个问题：③ 之前聊过什么 ⑥ 谁说了算

## 要回答的问题

用户 bob 的主节点坏了，谁接着服务？接手节点能看到哪些历史，哪些轮次必须由用户核对？本阶段只增加 `replication` 单元：沿用用户分片、路由、迁移、uid 进程隔离和 hub 权限，在每个分片旁边放一份异步副本。

## 核心概念

| 分片 | 初始主节点 | 初始从节点 |
|---|---|---|
| 0 | node-a | node-b |
| 1 | node-b | node-c |
| 2 | node-c | node-a |

etcd 的 `/codex/shards/<id>` 保存 `{ primary, replica, epoch }`，PG `shard_owners` 保存同一归属和 `replica_ready`。用户仍经 64 个哈希槽映射到三个分片；范围策略、用户例外表和手动迁移操作单保留。磁盘是三份独立目录。

**异步复制与位点。** 用户一轮结束后等待 5 秒，同用户连续请求合并。复制前暂停本地派发，等待已经进入边界的请求，检查该用户全部会话无 `starting/running/steering`，关闭该用户空闲 Codex 进程，再导出 CODEX_HOME、workspace 和知识库不可变正文。全量 tar 直接复用分片迁移 transfer 模块。后台调用显式 `runOwner`；会话边界继续通过 `pool.withOwner`、hub `withUser`。

为什么只在轮次边界复制？运行中的 Codex 正在修改 SQLite、JSONL 和工具产物；目录能被读取，不表示它是一个一致的会话快照。复制期间的新任务留在 PG/Redis 排队，复制结束再派发。一个用户的其他会话仍在执行时，本轮不复制。

从节点逐次核对调用方节点密钥、PG 当前主节点、replica、epoch 和复制操作单。两个目录与附属内容全部成功，主节点才以 SH001 保护写入 `replication_positions(user_id, shard_id, epoch, last_task_sequence, replicated_at)`。未完成传输操作单会阻止提升，避免提升半份目录。导入期间保留原目录用于人工恢复，磁盘空间需要运维关注。

**空闲兜底与延迟。** 每 60 秒检查空闲用户；以用户 uid 计算 CODEX_HOME 内容哈希，workspace 以服务身份计算，排除顶层 `tmp/`，内容、属主和权限未改变且位点一致则跳过。`/cluster` 按分片、用户显示未复制的已完成轮次数量和最早未复制轮次的等待秒数。空闲且已同步的用户不会因长时间未说话被误报。任何用户等待超过 300 秒，分片标记 `replica_lagging`；复制错误和未追平也显示副本落后。`/ready` 仍为 200，附 `degraded.replica_lagging`，主节点继续服务。

**故障接管。** 成员 TTL 固定 10 秒，客户端约 TTL/3 续约。control Watch 到主成员键消失，确认副本在线、`replica_ready=true`、所有用户有当前 epoch 的基线位点且没有未完成复制，再在 `cluster_term` 事务中推进归属：主改为原从、从设 null、epoch+1、ready=false。PG 提交后才 guardedPut etcd。发布失败时 `publishing=true`，新旧节点都不能派发；control 对账补发。新主完成恢复后才清除 `recovering`。

| 故障时的任务 | 接管后 | 是否自动重跑 |
|---|---|---|
| 已发给 Codex、仍在执行 | `unconfirmed`，会话暂停，待核对 | 否 |
| `completed` 且 sequence 大于最后复制位点 | `replica_missing`；保留 PG 任务，提示「该轮结果在故障接管时丢失，请核对」 | 否 |
| `queued`，且用户 home 存在 | 保留 queued，由新主 outbox 唤醒 | 是正常首次派发；同会话有待核对任务时先核对并继续 |

接管恢复时若该用户的 `CODEX_HOME` 完全缺失，会持久标记已有会话。读取或恢复原会话返回 `409 REPLICA_MISSING`，提示原会话无法恢复、请新建会话，任务记录已标记待核对；未派发任务转为 `needs-review`，不自动执行。新建会话不继承丢失标记。升级时需执行新增的 `020-replica-missing.sql` 迁移。

复制发布成功后删除本次替换的旧目录；私有 home 由用户 uid 清空，服务再删除外层目录，清理失败只记日志。迁移仍默认保留 `.before-move-*` 供恢复；此次修改不会扫描或删除历史遗留目录。

接受的丢失窗口是**最后一次复制之后**。5 秒是合并等待时间，不是数据零丢失承诺；长轮次、网络故障和复制耗时都会扩大窗口。`replica_ready` 表示已建立完整基线，并不代表与正在服务的主节点逐字节同步。

**epoch 隔离与回归。** epoch 增加后，旧主的业务写入和复制位点写入由 PG 返回 SH001。旧主刷新缓存，发现自己不是主，只停止该分片用户的进程；它仍可服务其他分片。成员租约失效的整个节点仍沿用原有隔离与 rejoin 流程。旧主重新加入，control 将其设为从节点、ready=false；新主全量推送该分片全部用户，全部成功后 ready=true。不会自动切回。

**手动切换。** `npm run cluster -- promote 0` 需要 admin，任意入口转交当前 control。要求 ready=true；PG 持久化暂停分片 → 等待执行中轮次结束 → 最后一次全量同步 → PG 切换 → etcd 发布 → 新主恢复派发。复制失败会保留暂停，可以修复原因后重试同一命令；禁止人工回滚 epoch。

## 分工

| 部件 | 负责什么 |
|---|---|
| `replication/worker.mjs` | 轮次边界、5 秒去抖、60 秒兜底、失败记录 |
| `replication/store.mjs` | 位点、落后统计、三类任务恢复 |
| `replication/control.mjs` | 环形放置、CT001 切换、发布对账、旧主回归 |
| `replication/index.mjs` | 生产运行环境、认证传输、显式用户身份与恢复 |
| 原 sharding / transfer | SH001、Watch 缓存、每节点密钥、路由和安全 tar |

uid 隔离、hub 双侧授权、跨分片只读请求携带用户令牌、任期 CT001、分片 SH001、迁移操作单均继续执行。节点只持有自己的 SQL 角色、etcd 凭据、节点密钥及网关访问密钥；服务商密钥留在 gateway。

## 跑起来看看

```bash
cd stages/s18-replication
npm ci
npm test
npm run lesson -- list
npm run lesson -- replication-boundary
npm run lesson -- replication-lag
npm run lesson -- replication-recovery
npm run lesson -- replication-fence
```

单机 Docker 三节点沿用部署脚本。先复制 `.env.example` 为 `.env`，填模型网关、数据库、Redis、etcd 和三个节点的独立凭据，运行 `bash deploy/configure.sh` 生成配置。完整远程安装入口：

```bash
DEPLOY_HOST=example.com bash deploy/remote.sh check
DEPLOY_HOST=example.com bash deploy/remote.sh init-env
DEPLOY_HOST=example.com bash deploy/remote.sh deploy
DEPLOY_HOST=example.com bash deploy/remote.sh auth-init
DEPLOY_HOST=example.com bash deploy/remote.sh user -- add bob
DEPLOY_HOST=example.com bash deploy/remote.sh tunnel
npm run login
npm run cluster -- status
```

入口 `127.0.0.1:4336`，内部节点 `4340–4342`，数据库 `agent_s18`，Compose 项目和 systemd 单元 `codex-harness-s18`，固定部署路径 `APP_DIR=/opt/s18-replication`。基础镜像 digest 沿用原值。先让 bob 完成两轮，等待 `/cluster` 对应用户落后为 0、分片 ready=true，再测试：

```bash
# 先查 bob 实际所在主节点，下例假设是 node-a / 分片 0。
docker compose kill node-a
# 观察租约消失、新主 node-b、epoch+1；原有已复制历史可以续聊。
docker compose up -d node-a
# node-a 以 replica 回归；等全部用户追平后 ready=true。
npm run cluster -- promote 0

# 假死：恢复后旧 epoch 写入不得生效。
docker compose pause node-a
sleep 15
docker compose unpause node-a

# 分区：先记下容器 ID，断开后检查另外两个分片仍能服务。
node_id=$(docker compose ps -q node-a)
docker network disconnect codex-harness-s18_default "$node_id"
# 恢复网络
docker network connect --alias node-a codex-harness-s18_default "$node_id"
```

外部验收（全部只用专用测试库，不能连接生产库）：

```bash
npm run test:data                 # 本机 initdb / pg_ctl / redis-server；包含真实 PG 接管测试
npm run test:runtimes:uid         # Linux root:1000，真实 PG+Redis，原生 Codex、模拟模型
npm run test:replication:etcd      # 全新 PG 测试库 + 真实认证 etcd
npm run test:ports                # 允许绑定本机端口时执行
```

uid 测试设置 `DATA_TEST_DATABASE_URL`、`DATA_TEST_REDIS_URL`，只给 CHOWN/FOWNER/SETUID/SETGID，不能给 DAC_OVERRIDE。新增三节点 uid 用例会创建并删除专用临时数据库；三实例共用它，各自独立目录。etcd 用例设置 `ETCD_TEST_ENDPOINT` 和 `ETCD_TEST_NODE_A_PASSWORD`、`ETCD_TEST_NODE_B_PASSWORD`、`ETCD_TEST_NODE_C_PASSWORD`，用 node-a/b/c 认证，验证真实租约自然过期而非主动删除。etcd 前缀 `/codex/` 必须属于独立测试实例。

### Docker 中的外部测试

下面创建独立 `codex-s18-accept` 项目和两个测试数据库，不连接正在服务的项目。测试镜像先通过 `docker compose build node-a` 构建；测试环境的 `.env` 只需教学凭据。另选子网避免与三节点演示网络冲突。

```bash
export REMOTE_BRIDGE_SUBNET=172.29.19.0/24 REMOTE_BRIDGE_GATEWAY=172.29.19.1
accept() { docker compose -p codex-s18-accept -f compose.yaml -f deploy/acceptance.compose.yaml --profile acceptance "$@"; }
accept up -d postgres redis etcd
accept run --rm --no-deps etcd-init
accept up -d --wait postgres redis etcd
accept exec -T postgres createdb -U agent agent_s18_test
accept exec -T postgres createdb -U agent agent_s18_etcd_test
accept run --rm uid-tests node --test tests/replication-pg.integration.mjs
accept run --rm uid-tests
accept run --rm etcd-tests
# 保留失败日志；完成核对后仅删除这个一次性项目。
accept down -v
unset REMOTE_BRIDGE_SUBNET REMOTE_BRIDGE_GATEWAY
```

## 两台服务器

控制机 `control.example.com` 运行 PG、Redis、etcd、gateway、Caddy、node-a、node-c；第二台 `worker.example.com` 只运行 node-b。仍保留三个分片的环形布局。第二台默认 700m、`AGENT_RUNTIME_LIMIT=2`，可在 `.remote.env` 调整为 1–4。

网络路径：远程 node-b → 本机 SSH `-L` 回环端口 → 控制机 `remote-access` 回环端口 → Docker 内基础服务。node-b 访问 node-a/c，通过本机 4340/4342 隧道。控制机节点访问 `host.docker.internal:4341` → bridge 网关 relay → 控制机回环 14341 → SSH `-R` → 第二台回环 4341。所有对宿主发布的基础服务端口都绑定 127.0.0.1；bridge relay 仅监听配置的 Docker 网关地址，不监听公网地址。

1. 两台 Linux 都装 Docker Compose（支持 `!override`），代码都放在 `/opt/s18-replication`。先设置控制机 `.env`，额外加入：

```dotenv
COMPOSE_FILE=compose.yaml:deploy/two-host.compose.yaml
COMPOSE_PROFILES=remote-access
AGENT_NODE_ADDRESS_B=http://host.docker.internal:4341
NODE_B_UPSTREAM=host.docker.internal:4341
```

2. 控制机首次初始化使用以下步骤。两台模式不要调用会显式启动本地 node-b 的 `server-setup.sh` / `remote.sh deploy`；也不要同时启动第二个 node-b。

```bash
cd /opt/s18-replication
docker compose build node-a
bash deploy/configure.sh
docker compose up -d etcd
docker compose run --rm --no-deps -T etcd-init
docker compose up -d --wait etcd postgres redis gateway
docker compose run --rm --no-deps --user 0 -T -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/cluster-migrate.mjs
docker compose run --rm --no-deps -T node-a npm run -s agent:init
cp nodes/node-a/.data/identity.json nodes/node-c/.data/identity.json
docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts init
docker compose up -d node-a node-c caddy remote-access remote-node-link
bash deploy/enable-service.sh
# 只导出 node-b 最小凭据，绝不复制控制机整个 .env。
umask 077
node deploy/remote-env.mjs > .remote.env
scp .remote.env worker.example.com:/opt/s18-replication/.remote.env
scp nodes/node-a/.data/identity.json worker.example.com:/opt/s18-replication/.remote-identity.json
# 无密钥的启用模型提供方清单；在第二台先 mkdir -p 对应目录。
ssh worker.example.com 'mkdir -p /opt/s18-replication/nodes/node-b/.data/gateway'
scp .data/gateway/enabled-providers.json worker.example.com:/opt/s18-replication/nodes/node-b/.data/gateway/
```

3. 第二台准备独立 SSH 密钥 `/root/.ssh/s18-tunnel`，将公钥加入控制机允许端口转发的账号，核对控制机 host key 后写入 known_hosts。无需开启 `GatewayPorts`：反向监听只需控制机回环。随后运行：

```bash
cd /opt/s18-replication
CONTROL_HOST=control.example.com SSH_USER=root bash deploy/remote-node.sh
systemctl status codex-harness-s18-tunnel codex-harness-s18-remote
```

脚本安装一条由 systemd 自动重连的 SSH 隧道和一个节点容器，不部署第二份控制面。`NODE_ID`、`NODE_PORT`、`REVERSE_PORT`、`CONTROL_HOST`、`SSH_USER`、`SSH_KEY` 可配置；更换远程角色时需相应调整控制机禁用的本地节点、relay 端口、广告地址和 Caddy upstream，不能保留两个同名成员。脚本按 NODE_ID 转发另外两个节点端口；控制机 relay 和 two-host override 也应对应调整。更换子网时同时设置 `REMOTE_BRIDGE_SUBNET` 和 `REMOTE_BRIDGE_GATEWAY`。

4. `/cluster` 确认三成员和副本 ready。让 bob 在分片 0 完成两轮，等复制为零落后后在控制机停 node-a；node-b 应接管。恢复 node-a 后观察全量追平，再用 admin promote 验证手动切换。备份/恢复时同时停第二台节点与隧道相关业务；原单机备份脚本不包含第二台磁盘，应分别备份并核对同一业务时点，不能把旧磁盘直接挂到新 epoch。

## 关键代码

`server/modules/replication/control.mjs`：

```javascript
export const ring = id => ({ primary: `node-${'abc'[Number(id)]}`, replica: `node-${'abc'[(Number(id)+1)%3]}`, epoch: 1 });
```

`server/modules/replication/worker.mjs`：

```javascript
export const DEBOUNCE_MS = 5000;
export const IDLE_SYNC_MS = 60000;
```

`server/modules/replication/store.mjs`：

```javascript
export const MISSING_MESSAGE = '该轮结果在故障接管时丢失，请核对';
export const MISSING_SESSION_MESSAGE = '该用户在最近一次复制之前的故障接管中丢失了数据，原会话无法恢复，请新建会话；任务记录已标记待核对';
export const LAG_MS = 5 * 60 * 1000;
```

完整时序和状态约束见 [docs/design.md](docs/design.md)。

## 限制

PG、Redis、etcd 和 gateway 仍是控制面单点；副本不等于整个服务高可用。没有自动再平衡，每分片只配置一个副本；从节点离线、未建好基线、存在未完成传输时不接管，分片 unavailable 并记录原因。

每轮边界全量 tar 和目录哈希会读取整个目录，大目录会占磁盘 IO、网络与暂存空间。单次上限默认 1 GiB，可通过 `AGENT_TRANSFER_MAX_BYTES` 下调；接收端检查两倍上限的可用空间。迁移保留的旧目录、升级前的复制旧目录或清理失败残留，需停服核对后人工归档清理。副本是可核对的异步历史窗口，不提供零丢失或自动重跑保证。

## 小结

③ 的答案由原生 CODEX_HOME 加复制位点共同给出；⑥ 的答案由 etcd control 任期、PG CT001 与逐分片 epoch SH001 共同给出。任务记录留存，副本缺失必须明确展示给用户。

## 从这里往哪里走

下一章：无，路线图到此结束。生产化可以继续建设三节点 etcd、PG 高可用、独立对象存储和增量复制；再根据真实恢复时间、目录规模与允许丢失窗口设定服务目标。
