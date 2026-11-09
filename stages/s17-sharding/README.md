# s17：分片与路由

[导论](../introduction.md) → [s00](../s00-sdk-quickstart/) → [s01](../s01-single-turn/) → [s02](../s02-multi-turn/) → [s03](../s03-service/) → [s04](../s04-events-messages/) → [s05](../s05-agent-assembly/) → [s06](../s06-tools/) → [s07](../s07-memory/) → [s08](../s08-data-layer/) → [s09](../s09-knowledge-layer/) → [s10](../s10-skill-workflow/) → [s11](../s11-model-gateway/) → [s12](../s12-deploy/) → [s13](../s13-auth/README.md) → [s14](../s14-isolation/README.md) → [s15](../s15-hub/README.md) → [s16](../s16-coordination/README.md) → `s17` → [s18](../s18-replication/README.md) → [app](../../app/)

对应六个问题：③ 之前聊过什么 ⑥ 谁说了算

[导论](../introduction.md) · [s16 → s17 增量](../CHANGES.md#s17) · [总架构图](../../app/web/public/course/assets/s17-architecture.svg)

## 要回答的问题

一台机器放不下所有用户，怎样让每位用户去正确的机器，又让任意入口都能找到他？本章在 s16 协调面之上只增加 `sharding` 单元。保留 s14 的数值 uid、每用户进程与 CODEX_HOME，保留 s15 Hub 授权，保留成员租约、选举、任期、Watch 对账、自我隔离和重新加入。

## 核心概念

**分片键是用户 ID，不是消息。** Codex 的原生历史、SQLite 状态和记忆保存在该用户的 CODEX_HOME。同一用户的不同消息若分到不同机器，后续轮次就看不到完整历史。数据库用户 UUID 同时用于分片与 s14 的运行目录映射，用户名只用于 CLI 查找。

**策略和节点归属分开。** `strategy.shardOf(userId, map)` 只回答用户属于哪个分片。默认 `AGENT_SHARD_STRATEGY=slots`：SHA-256 的前 32 位无符号整数取模 **64**，64 个槽按 `slot % 3` 分到 `0/1/2`，槽数分别为 22/21/21。`range` 用用户 ID 去连字符后的首字节：`00–54`、`55–a9`、`aa–ff` 分别映射 `0/1/2`。范围策略直观，但用户 ID 分布不均时会产生热点。所有节点配置必须一致；已有数据不能通过改环境变量迁移策略。

**归属只有 control 能修改。** etcd 存 `/codex/shards/<id> = {primary, epoch}`、`/codex/slots`、`/codex/overrides/<userId>`。override 优先于两种策略。control 以 s16 `guardedPut` 的选举任期事务发布；初次把三个分片分别放到三个成员，新增成员只填无主分片。节点离开仍保留原 primary，状态成为 `unavailable`，不自动重平衡、不故障切换。

**本地缓存不等于永远正确。** 启动对 `/codex/` 做一次一致性快照并记 revision，再从 revision + 1 Watch。一个整前缀 Watch 同时覆盖 shards、slots、overrides，避免多个 Watch 的进度无法比较。断线、压缩后整表重读；每 **5 秒**对账。读快照期间发生的新事件会重放，不允许 revision 倒退。

**任意健康节点可接入。** Caddy 按 `/ready` 检查，所有已加入且业务栈完成本分片恢复的节点都可返回 200。节点先认证用户，再用 `routeOf` 找主节点；非主保留终端 Bearer，带本节点 ID/独立密钥、用户 ID、路由 revision 转发。主重新认证用户与调用节点，核验归属和自己的 revision 不落后，失败返回 **409 STALE_ROUTE**；转发方刷新并且只重试 **1 次**。无主或主节点离线返回 **503 SHARD_UNAVAILABLE** 和原因。普通转发 **30 秒**超时；SSE 不设时限、保持背压与断开传播。事件只在用户主节点产生，代理不重编 Last-Event-ID。

**数据库隔离按分片。** `user_shards` 将用户映射到分片，`shard_owners` 保存节点和 epoch。每个业务事务设置 `SET LOCAL app.node`、`app.shard_epoch`（代码用事务局部 `set_config(..., true)` 参数化），行触发器从 owner/user 或关联会话、知识库、资源追溯到用户，核对节点角色、owner 与 epoch，否则 **SH001**。同时锁住两张映射表的对应行到提交，迁移不能越过旧事务。最终的 check_shard 还检查迁移操作单：paused 阶段允许在途轮次收尾，用户暂停且单据为 copying、copied、switched 或 failed 时拒写。收到 SH001 按被拒行 owner 诊断；刷新前自认为主且刷新后仍如此或刷新失败时隔离，确认用户已移走则只拒绝当前请求。`cluster_term` 继续保护 control 的元数据写入。全局表规则见 [design.md](docs/design.md)。

**共享知识库只有一份。** 被授权者的主节点先按 s15 Hub 判断，再带节点身份、密钥和终端用户 Authorization 向所有者主节点发内部只读请求。所有者主节点重新认证用户令牌、读取授权表并判断，最后读自己磁盘上的内容。撤销授权即使发生在两次判断之间也不会放行；未授权者看到 404。

**手动迁移要经过停写边界。** admin 执行 `npm run cluster -- move <username> <shardId>`，请求交给 control：创建 30 分钟有效的操作单并持久化暂停 → 源节点停止新派发与新媒体轮询 → 等执行中的轮次、索引和已开始的媒体轮询结束 → 关闭用户进程 → 内部 HTTP 流式 tar 复制 CODEX_HOME 与 `workspace/users/<id>`，保留数值 uid/gid → 搬运关联正文和本地索引 → control 事务提交 `user_shards` 与操作单 switched，再发布 override → 刷新并恢复派发。源副本暂留供运维核对，不参与服务。失败将操作单标为 failed 并保持暂停；保留磁盘与已提交的 PG 归属，运维核对副本和操作单后恢复，不自动回退或重放失败操作。没有 SSH 数据传输或后台复制。媒体 tick 在异步准入前登记 pollingOwners，每次 poll 前执行 canDispatch；暂停期间跳过新轮询，drain 的 waitOwner 等待已开始的轮询和准入检查。

## 分工

| 层 | 本章职责 |
|---|---|
| coordination | TTL **10 秒**、etcd3 自动 KeepAlive（约 TTL/3）、Election、create revision 任期、失联隔离与 Rejoin |
| sharding | 64 槽 / 范围策略、归属缓存、控制放置、路由、双重授权读、手动迁移 |
| PostgreSQL | 全局账号和 Hub 授权；业务行按用户分片隔离；任务与迁移暂停状态持久化 |
| Redis | 各节点自己的唤醒集合；PG 仍决定归属、任务次序和派发 |
| Caddy | 任一健康节点接入；节点再按用户路由 |
| 节点磁盘 | 各自独立的 `.data`、`workspace`、`.runs`；`backups/node-a|b|c` 分开备份 |

s16 的共享卷在本章改为独立磁盘。三个节点只有部署 identity UUID 相同；文件内容没有共享挂载。节点坏了，它负责的分片就不可用，其他分片照常工作。**s18 才解决副本与故障接管。**

## 跑起来看看

先完成离线实验（Node 24，不调用模型、不监听端口）：

```bash
cd stages/s17-sharding
npm ci
npm test
npm run lesson -- list
npm run lesson -- strategies
npm run lesson -- stale-route
npm run lesson -- shard-fence
npm run lesson -- move
```

真实单机演示需要 Docker、Linux uid 隔离和可用模型网关；这些命令不属于离线测试。在本阶段复制 `.env.example` 为 `.env` 并填写模型服务商配置。生成独立的实验凭据，禁止把输出贴到日志：

```bash
node scripts/deploy-env.mjs "$PWD" > .env.generated
mv .env.generated .env
chmod 600 .env
docker compose build node-a node-b node-c
bash deploy/configure.sh
docker compose up -d etcd
docker compose stop node-a node-b node-c
docker compose run --rm --no-deps -T etcd-init
docker compose up -d --wait etcd postgres redis gateway
docker compose run --rm --no-deps --user 0 -T -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/cluster-migrate.mjs
docker compose run --rm --no-deps -T node-a npm run -s agent:init
# 只同步部署身份，不同步用户数据目录。
cp nodes/node-a/.data/identity.json nodes/node-b/.data/identity.json
cp nodes/node-a/.data/identity.json nodes/node-c/.data/identity.json
docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts init
docker compose up -d --wait node-a node-b node-c caddy
export AGENT_SERVER_URL=http://127.0.0.1:4335
npm run login
npm run cluster -- status
```

入口只发布 `127.0.0.1:4335`，节点内部端口 `4340–4342`，不同 Compose 项目的网络隔离。数据库 `agent_s17`，项目与 systemd 单元 `codex-harness-s17`，服务器固定目录 `APP_DIR=/opt/s17-sharding`，示例域名 `example.com`。镜像 digest 沿用上一章已核实值。

三个节点挂载共享的 `.data/gateway` 目录，运行时只读取服务商清单；`deploy/configure.sh` 的一次性生成器通过该目录写入配置。目录挂载保持可写，避免生成清单时触发只读单文件挂载的 EROFS。

etcd 使用独立的 `health` 用户和同名角色，**只能读取精确的 `health` 键**，不能写入，也不能读取 `/codex/` 或其他键。`init-env` 随机生成 `ETCD_HEALTH_PASSWORD`，Compose 将其直接代入 `etcdctl --user health:… endpoint health`，不依赖镜像内的 shell。先启动 etcd（不等待健康），再运行 `etcd-init`，最后等待 etcd 和其余服务健康；初始化遇到连接失败会重试，最多 60 秒，并支持已有用户、角色及已开启认证的数据卷。

已有服务器升级时，保留 `.env` 中原有的 root、节点、数据库等密码，只补充随机的 `ETCD_HEALTH_PASSWORD`（例如用 `openssl rand -hex 24` 生成后写入 `.env`）。不要重新生成整份 `.env`。按上述流程或 `remote.sh deploy` 重新部署后，初始化脚本使用原 root 凭据补建 health 用户和角色，随后健康检查通过；数据卷无需删除，认证无需关闭。

1. **新用户分布**：重复执行下面命令创建几个示例账号，control 在 5 秒内分配，首次认证业务请求也会要求 control 补齐映射。用 `cluster status` 观察分片、槽数、每节点用户数和路由 revision。随机 UUID 不保证三个样本恰好各占一个分片，多建几个观察即可。

   ```bash
   docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts add alice
   docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts add bob
   docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts add carol
   ```

2. **从任意节点进入**：用 Caddy 登录并聊天。另在容器网络内分别从 `http://node-a:4340`、`http://node-b:4341`、`http://node-c:4342` 请求同一用户会话，应到同一主节点。使用 [端口集成测试](tests/sharding-http.integration.mjs) 检查 HTTP 转发、SSE 和 STALE_ROUTE；不要把节点端口发布到公网。
3. **共享知识**：bob 创建知识库并授予 carol；将二者放到不同主节点，carol 的 `kb_read`/`kb_search` 成功，未授权 dave 返回 404。撤销后再次读也应 404。正文只来自 bob 的主节点。
4. **节点故障**：先在状态中确认 node-b 所有的分片，然后执行 `docker compose kill node-b`。租约至多约 10 秒后成员消失；它的分片 503，另外两个分片仍可对话。`docker compose up -d node-b` 后原主恢复并将未确认轮次标为待核对，不自动重跑。也可用 `docker compose pause node-b`，等待 15 秒再 `docker compose unpause node-b`，观察旧代次隔离并重新加入；用 `docker network disconnect codex-harness-s17_default "$(docker compose ps -q node-b)"` 模拟分区，再用 `docker network connect --alias node-b ...` 恢复网络。
5. **迁移**：确认源、目标都在线，**在客户端**设置 `AGENT_SERVER_URL` 指向 SSH 隧道入口（例如 `http://127.0.0.1:4335`），运行 `npm run login` 并使用 admin 账号登录，然后执行 `npm run cluster -- move <user> <shard>`，例如 `npm run cluster -- move bob 2`。若 bob 已在 2，选择其他分片。源节点不接新派发，等正在执行的轮次结束才拷贝。重新查询会话、原生历史、记忆和知识库，应与迁移前一致；用 `stat -c '%u:%g'` 比较两端目录和原生文件，数值属主不变。CODEX_HOME 的顶层 `tmp/` 是 Codex 运行时临时目录，不复制；workspace 由服务身份通过组 1000 读写，保留 root 或用户 uid 的数值属主。若中途失败，核对操作单、PG 暂停与归属、etcd override 及两端副本；beginMove 拒绝已暂停用户，重复 move 不会自动恢复失败操作，不要手工只修改 etcd 键。

外部验收（需相应服务，沙箱未执行）：

```bash
npm run test:data              # 临时真实 PG + Redis；含 sharding-pg.integration.mjs
npm run test:ports             # 监听回环端口的 HTTP/CLI/SSE 测试
npm run test:runtimes:uid      # Linux 0:1000 + 专用 PG/Redis；含双节点迁移、模拟模型续聊与旧主 SH001
npm run test:hub:pg
npm run test:hub:uid
# 使用独立、带认证的测试 etcd，不指向正在服务的 /codex/。
ETCD_TEST_ENDPOINT=http://127.0.0.1:2379 \
ETCD_TEST_NODE_A_PASSWORD="$TEST_NODE_A_PASSWORD" \
ETCD_TEST_NODE_B_PASSWORD="$TEST_NODE_B_PASSWORD" \
ETCD_TEST_NODE_C_PASSWORD="$TEST_NODE_C_PASSWORD" \
DATA_TEST_DATABASE_URL="$TEST_DATABASE_URL" \
DATA_TEST_REDIS_URL="$TEST_REDIS_URL" npm run test:sharding:etcd
npm run test:coordination     # 同样需要上述 ETCD_TEST_*；使用空测试实例
```

etcd 集成测试验证 `guardedPut` 的动态 control 权限、1 秒内 Watch、错误凭据及 `/codex/` 外 ACL 拒绝。节点均可参加选举，静态 etcd RBAC 无法表达“当前 elected”；它限定凭据的键空间，**应用写入口**实施任期检查。拥有节点密钥/数据库角色的节点属于可信服务端，不能将其发给最终用户。

配置上述全部测试变量时，还会启动三个独立目录的节点，共用测试 PG/Redis 和带认证 etcd，经过固定转发到非目标 node-c 的 HTTP 入口迁移 dave，再立即请求 `/sessions`，要求 200。缺少变量时该用例明确跳过；测试 PG 的任期不能超前于测试 etcd 的选举 revision。入口由测试内置反向代理提供，无需安装 Caddy。

运维可用 admin token 请求 `GET /cluster/route?username=dave`。响应按节点列出 `routeOf`、原始 `override` 及类型、`localPaused`、PG `user_shards` 行、`owns`、`shardMatches` 和 `canDispatch`；无法联系的节点单独返回 `error`。诊断不会刷新缓存，保留 Watch 延迟现场，各节点结果是独立采样。override 写入 JSON 字符串；旧的数字值仍可读取，路由统一为字符串分片 ID，以便与 PG 严格比较。

远程操作：`DEPLOY_HOST=example.com bash deploy/remote.sh check|init-env|deploy|auth-init|status|tunnel`。服务器 deploy 自动核对并分发相同 identity，安装 `codex-harness-s17.service`。`bash deploy/backup.sh` 停三个节点、逐节点备份；`bash deploy/restore.sh <timestamp> --yes` 校验三份备份后恢复。下载保留 `backups/node-a|b|c` 层级。PG 恢复后还需核对 etcd override 与磁盘备份属于同一业务时点，不能把单个分片的旧磁盘直接接到新路由上。

## 关键代码

[策略](server/modules/sharding/strategy.mjs)将用户与节点解耦：

```javascript
export const slotOf = id => createHash('sha256').update(String(id)).digest().readUInt32BE(0) % SLOT_COUNT;
```

[缓存](server/modules/sharding/cache.mjs)统一暴露路由，override 优先：

```javascript
  routeOf(userId) {
    // Older controls wrote bare 0/1/2: JSON.parse turns those bytes into numbers.
    // Keep the raw override for diagnostics, but all routing/PG comparisons use text IDs.
    const raw = this.overrides[userId] ?? this.strategy.shardOf(userId, this);
    const shardId = ['string', 'number'].includes(typeof raw) && SHARDS.includes(String(raw)) ? String(raw) : null;
    const owner = this.shards[shardId];
    return { shardId, primary: owner?.primary ?? null, epoch: owner?.epoch ?? null, revision: this.revision };
  }
```

[主节点](server/modules/sharding/routing.mjs)不会信任转发方的缓存：

```javascript
export function validateRoute(cache, userId, nodeId, revision) {
  if (!/^\d+$/.test(String(revision)) || cache.routeOf(userId).primary !== nodeId || BigInt(cache.revision) < BigInt(revision)) throw staleRoute();
}
```

数据库行触发器在 [016-sharding.sql](server/modules/data/migrations/016-sharding.sql)，最终 check_shard、操作单与列级权限在 [018-move-security.sql](server/modules/data/migrations/018-move-security.sql)，事务边界在 [write.mjs](server/modules/data/write.mjs)，迁移编排在 [move.mjs](server/modules/sharding/move.mjs)。

## 限制

- 节点使用独立的 `AGENT_NODE_KEY_A/B/C`（`init-env` 生成）；每个运行容器只有自己的明文密钥和三个节点的 SHA-256 验证哈希。内部请求以 `x-node-id` 和该节点密钥确定调用节点；迁移六个接口还必须提供 30 分钟有效的 `move_operations` 操作单，校验 control/源/目标角色、用户、接收节点和步骤状态。节点仍共享业务数据库与控制面信任，不能把被攻陷的节点当作隔离租户；这仍是教学级部署，没有 mTLS，内部 HTTP 不提供传输加密，须限制在可信网络。
- 全局账号表对节点只开放 `UPDATE(plan_id)`，不授予建号、改用户名/角色/密码或禁用权限；`auth:init` 与 CLI `user:add/passwd/disable` 使用 maintenance 运维连接。`auth_sessions` 仅允许 INSERT 和 UPDATE(last_seen_at, revoked_at)，无 DELETE；`agent_versions` 允许 INSERT，不允许修改或删除。已有安装通过 018 迁移收紧权限，部署仍需执行节点角色 provision。
- 跨分片知识读取携带终端用户 Authorization；所有者节点通过全局账号/会话表重新认证，再取新的 Hub 权限快照。同一节点后续工具调用只复用内存中该用户最近已认证的终端令牌，不写入任务、磁盘或操作单；节点重启或迁移后须先收到新的已认证请求，缺令牌时拒绝跨分片读取。请求正文中的 requester 一律拒绝；无有效终端令牌、会话撤销或用户禁用均不能以节点密钥代替授权。

- 节点坏了，其分片不可用；本章无副本、复制位点、自动接管或自动再平衡。
- PostgreSQL、Redis、模型网关仍为单实例；教学 etcd 也是单节点，控制存储存在单点。control 进程可重新选举，这不能消除单节点 etcd 的故障点。etcd 不可用时超过 TTL 会停止服务；生产升级见 [production.md](docs/production.md)。
- etcd 与 PG 没有跨库原子提交。control 持有 PG 任期锁，先提交映射与操作单 switched，再发布 etcd override；映射锁阻止越过切换的旧写入。etcd 发布失败会报警、将操作单标为 failed 并保持暂停，不把旧副本恢复为主。对账仅采纳有 switched/resumed 操作单的目标 override；无操作单、未复制完成或 failed 的 override 会被记录并忽略。不要把此流程称为分布式原子事务。
- 手动迁移要求源和目标在线、同一固定绝对 APP_DIR、同一数值 uid 映射。tar 拒绝链接、设备文件、路径穿越、不匹配属主和 setuid；普通文件清除全部特殊权限位，目录只保留 setgid。tar、正文和索引的单次接收上限为 1 GiB，`AGENT_TRANSFER_MAX_BYTES` 只可下调；超限中止并删除临时文件，写入前目标卷须有至少两倍上限的可用空间，否则返回 507；一次目录拷贝超过 30 秒会失败并保留源。迁移不是损坏磁盘恢复工具。
- SSE 序号在当前主节点进程内连续；迁移或重启之后新事件代次让客户端回到快照，不承诺跨主节点的永久全局序号。
- s16 使用的 etcd3 **1.1.2** Election 共享 lease 适配依赖固定版本内部调用顺序；升级必须重跑认证集成测试。依赖与 s16 完全一致，未增加库。

## 小结

用户的历史随用户分片留在同一主节点。入口通过带 revision 的缓存定位，数据库用 owner 与 epoch 守住写入边界，跨分片读取继续通过 Hub，手动迁移在暂停后切换归属。

## 从这里往哪里走

下一章：[s18 副本与故障接管](../s18-replication/README.md)。
