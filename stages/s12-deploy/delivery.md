# s12 交付与外部验收

只新增 `stages/s12-deploy/`；没有修改其他阶段、app 或根级校验器，没有 Git commit。新阶段复制自 s11，未带 node_modules、运行数据或 `.env`，保留版本化 examples 的 workspace。

## 相对 s11 的文件差异

以下路径均相对本阶段。未列出的文件原样继承。

<!-- FILE_DIFF_START -->
新增：

- `.dockerignore`
- `Dockerfile`
- `delivery.md`
- `deploy/Caddyfile.example`
- `deploy/backup.sh`
- `deploy/restore.sh`
- `deploy/check.sh`
- `deploy/configure.sh`
- `deploy/download-rsync.sh`
- `deploy/ready.mjs`
- `deploy/remote.sh`
- `deploy/server-setup.sh`
- `deploy/systemd/codex-harness-s12.service`
- `docs/production.md`
- `scripts/backup-lib.mjs`
- `scripts/backup.mjs`
- `scripts/deploy-env.mjs`
- `scripts/restore.mjs`
- `server/modules/deployment/index.mjs`
- `tests/deploy-backup.test.mjs`
- `tests/deploy-data.integration.mjs`
- `tests/deploy-health.test.mjs`
- `tests/deploy-lock.integration.mjs`
- `tests/deploy-queue.test.mjs`
- `tests/deploy-static.test.mjs`
- `tests/deploy.integration.mjs`

改动：

- `.env.example`
- `.gitignore`
- `05-app-server.test.mjs`
- `README.md`
- `compose.yaml`
- `docs/design.md`
- `lessons/README.md`
- `lessons/catalog.json`
- `package-lock.json`
- `package.json`
- `scripts/gateway-config.mjs`
- `server/main.mjs`
- `server/modules/config/index.mjs`
- `server/modules/data/index.mjs`
- `server/modules/data/jobs.mjs`
- `server/modules/gateway/index.mjs`
- `server/modules/http/index.mjs`
- `server/modules/messages/index.mjs`
- `snapshot.json`
- `tests/http-cli.test.mjs`
- `tests/routing-policy.test.mjs`
- `tests/usage.test.mjs`
<!-- FILE_DIFF_END -->

npm dependencies、optionalDependencies 及锁文件的依赖条目完全不变；package-lock 只改包名。Agent 镜像安装 lsof 与 bubblewrap，备份与恢复在服务器宿主机上执行，需要 docker compose，由 postgres:16 容器里的 pg_dump/psql 访问数据库。数据库 schema/migration 未变。

## 已执行的离线验证

- 新部署测试与相关既有回归合计 **134 项通过**，无失败、无跳过：`05-app-server.test.mjs`、`tests/deploy-*.test.mjs`、scheduling、workflows、gateway、model-router、routing-policy、native-search、usage。
- 6 个部署 shell 脚本的 `bash -n` 语法检查通过。
- 教学标题顺序、源码逐行摘录、四服务静态配置、回环端口、资源限制、日志轮转、健康检查、按服务分配凭据和 .dockerignore 均有测试断言。
- 离线调度使用真实 MessageService，HTTP 直接调用真实 handler，未监听端口；数据库门禁使用查询夹具，不能代替真实数据库锁验收。

未执行 npm ci、Docker、联网、监听端口、SSH 或真实模型调用。运行离线回归时临时复用 s11 已安装依赖，交付目录不保留该依赖链接。完整 `npm test` 中部分继承测试会监听端口，留给外部环境执行。

## 本机 Docker 验收

按 README 完成 `.env`、构建、配置生成、迁移与初始化。保持默认数值，不在验收时上调限制。

| 步骤/命令 | 预期 |
| --- | --- |
| `docker compose build agent` | 固定 Node 版本与 digest 构建成功，npm ci 按锁文件安装；镜像内没有 postgresql-client |
| `docker compose exec -T agent id -u` | `1000` |
| `docker compose ps` | postgres、redis、gateway、agent 均 healthy；仅 agent 发布 `127.0.0.1:4326` |
| `curl --fail http://127.0.0.1:4326/health` | HTTP 200，status=alive，version=dev 或部署 REVISION |
| `curl --fail http://127.0.0.1:4326/ready` | HTTP 200，status=ready，database/gateway/models=true |
| `npm run test:deploy:integration` | 真实 Compose 资源和日志配置通过；停止 gateway 后 ready=503、health=200；恢复 gateway 后 ready=200 |
| `docker compose run --rm --no-deps -T agent node --test tests/deploy-data.integration.mjs` | 201 个跨会话并发创建只成功 200 个；超额返回 QUEUE_FULL；确认任务也不能越过容量；单会话 101 个只成功 100 个。测试使用独立 UUID 范围并清理自己的数据 |
| `npm test` | 全部继承与新增单元测试通过；本步骤需要允许临时本机监听端口 |

不要把 `docker compose config` 的完整解析输出粘贴到日志或聊天：它会展开运行时凭据。若需检查，使用集成测试，它仅输出断言结果。验证镜像不包含 `.env`、原生数据与备份；用自行创建的测试标记值核对镜像文件和日志，勿把真实密钥放进搜索命令参数。

请求与 SSE：暂停其他客户端；用本机 `.data/connection.json` 的 token 在 Node 程序内部构造 Bearer（不要作为命令行参数）。同一地址、同一令牌在 60 秒内连续发出 121 次 GET /models，前 120 次成功，第 121 次 429 且 Retry-After 为正整数秒数。健康接口连续访问不消耗额度。窗口过后创建一个会话，打开 20 个 /events?threadId=... 连接，第 21 个 429；关闭一个后可再连。离线测试已直接覆盖这些 handler 行为。

SIGTERM：通过 CLI 发起一个仍在执行的任务，再在其他会话排队。运行 `time docker compose stop agent`。预期 agent 自收到 SIGTERM 起不再派发，30 秒内退出；数据库中执行任务为 unconfirmed，queued 保留。然后 `docker compose up -d --wait agent`，恢复后查看原会话：未确认任务不会自动重发，需先核对历史。人工正在运行的任务若恰好提前完成，可能正常 completed；不要把这种情况当作关闭失败。

## 备份恢复验收

在可丢弃的体验数据上进行恢复测试，先确保有可用备份。

1. 在 workspace 放入测试文件，创建测试会话。在宿主机执行 `bash deploy/backup.sh`（无需宿主 Node/npm）。应先停 agent，在 postgres 容器里执行 pg_dump，输出 `backups/<时间>/manifest.json`，再等待 agent healthy。
2. 检查该目录包含 `database.sql.gz`、`workspace.tar.gz`、`codex.tar.gz`、`state.tar.gz` 和 manifest。manifest 的 time/version 正确，四个文件的 size/sha256 与本地计算一致。state 包含实例身份与不可变正文，不包含 `.env`。
3. 连续做 9 次成功备份，目录中只保留时间最新的 7 份；失败或 partial 目录不冒充成功备份。下载期间触发备份应明确拒绝，不删除正在下载的数据。
4. 修改测试 workspace 文件后，在宿主机执行 `bash deploy/restore.sh <目录名>`。先看到 agent 停止，再出现确认。输入其他内容应取消并保持停止；输入 `RESTORE` 后用 postgres 容器里的 psql 重放 gzip 纯 SQL，恢复原文件、数据库和 Codex 原生历史，最终 /ready=200。
5. 用同一部署路径恢复原会话，应能继续使用历史。检查不确定任务的恢复语义，不以“数据库有行”代替原生会话恢复。
6. 修改一份可丢弃备份中的文件，再恢复该份。预期摘要校验失败、没有开始恢复且 agent 保持停止；改回有效备份后再恢复。不要修改唯一的有效备份。

备份与恢复在服务器宿主机上通过 Bash + docker compose 编排，不需要宿主 Node/npm。postgres 容器保持运行，agent 服务由脚本先停止；数据库客户端在 postgres 容器中运行，打包、manifest 校验和文件恢复在一次性 agent 容器中运行。不要挂 Docker socket 到 agent。备份保留策略只有本机最近 7 份，下载到本机后应自行安排独立保存。

## 真实服务器验收

依次执行，主机示例只使用 example.com；实际凭据只进本机/服务器的私有文件。

```bash
export DEPLOY_HOST=example.com
bash deploy/remote.sh check
bash deploy/remote.sh init-env
bash deploy/remote.sh deploy
bash deploy/remote.sh status
bash deploy/remote.sh tunnel
```

预期 check 通过；init-env 新建权限 600 的文件且不输出凭据；四服务 healthy；status 的 version 与服务器 REVISION 一致；隧道可访问本机 4326，公网不能直接访问 4326。验证 `systemctl is-enabled codex-harness-s12` 为 enabled，重启服务器后再次 status，应恢复 healthy。手动 stop 的容器服从 Docker unless-stopped 语义；systemd 开机仍会主动执行 compose up。

完成一次有效部署后修改本阶段一处可见教学代码并再次部署（不必 Git commit），记录两个 REVISION。执行 `remote.sh rollback`，预期返回上一版 REVISION、/ready=200、workspace 与会话数据仍在、容器工作目录保持固定。首次部署运行 rollback 应明确提示没有上一版。升级失败留下 `.deploy-pending` 后，再 deploy 应拒绝，rollback 成功后可重新部署。

```bash
bash deploy/remote.sh backup
bash deploy/remote.sh backup-download
bash deploy/remote.sh rollback
```

备份应输出目录名，下载到命令所在目录的 `./backups/`。选择足够大的测试备份，在两个终端同时 backup-download；第一个继续下载，第二个非零退出并提示已有下载，传输使用 `--bwlimit=200`。有 Node 的 Linux 测试机可运行 `node --test tests/deploy-lock.integration.mjs` 验证真实 flock（缺少 flock 明确 skip；服务器运行入口不需要 Node）。真实 SSH/rsync 测试仍不可省略。检查 HTTP /backups 返回未授权或 404，没有下载入口。

## 不确定之处与边界

- 当前环境不能验证镜像拉取、apt 镜像源、Linux bind mount 权限、Codex/bubblewrap 与宿主内核兼容性。数据库导出使用正在运行的 postgres:16 容器内的 pg_dump，宿主机执行 `docker compose exec -T postgres pg_dump`。
- 规定的内存限制保持原值，未实测 768m agent 与 256m gateway 在真实负载下的占用；OOM、CPU、磁盘和服务商可用性需要外部观察，不擅自调大。
- 镜像固定版本/digest 沿用 app 已验证值；数据库与 Redis 镜像版本沿用既有主线。未在本环境重新验证远端镜像可获得性。
- 全局事务容量的真实并发、SIGTERM 落库时序、原生历史恢复、systemd 开机、实际下载互斥与版本回滚均待以上外部验收。配置静态通过不能替代运行结果。
- 回滚不还原数据库和 `.env`，只适用于兼容 schema 的代码发布。破坏性迁移先备份，必要时人工恢复；本章没有自动 schema 降级。
- 备份恢复是维护操作而非跨存储原子事务；恢复失败保持停服。备份归档须可信，SHA-256 仅检查完整性。
- stages/verify.mjs 的列表截至 s11。受“只能新增本目录”限制，未注册 s12；新增静态测试验证同样的教学标题和摘录约束。
