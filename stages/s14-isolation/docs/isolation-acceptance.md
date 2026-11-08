# 用户运行环境验收

在本阶段目录执行。离线断言、真实数据库、系统权限与真实模型分别验证，不把模拟连接当作 OS 隔离证明。

## 离线

```bash
npm ci
npm test
npm run lesson -- routing
npm run lesson -- pool
npm run lesson -- crash
```

预期所有执行的断言通过。`npm test` 已排除监听端口的文件；本机 macOS 的文件系统可能清除 setgid 位，离线实验同时检查 chmod 请求值和读写权限，完整属主及 2770 在 Linux 验收。

## 端口与 PostgreSQL

以下操作必须在允许监听端口和连接数据库的环境执行。测试不读取生产 `.env`，使用专用测试库和 Redis。

```bash
npm run test:ports
DATA_TEST_DATABASE_URL='postgresql://agent:TEST_PASSWORD@127.0.0.1:5432/agent_s14' npm run test:runtimes:pg
DATA_TEST_DATABASE_URL='postgresql://agent:TEST_PASSWORD@127.0.0.1:5432/agent_s14' npm run test:auth:integration
DATA_TEST_DATABASE_URL='postgresql://agent:TEST_PASSWORD@127.0.0.1:5432/agent_s14' \
DATA_TEST_REDIS_URL='redis://127.0.0.1:6379/0' npm run test:runtimes:server
```

这里的 `TEST_PASSWORD` 是占位值，请替换为专用验收库的凭据；不要将生产口令写进共享终端记录。compose 默认不发布 PG/Redis，以上本机地址需要单独准备服务，或在已有的专用测试网络中替换地址。

预期结果：

- PG：schema 与 011 SQL 重复执行通过；同用户并发分配只得到一条记录；相邻用户 uid 连续；首个 admin 原路径与文件内容保留；禁用通知关闭对应运行环境，只把该 owner 的执行中任务改为 unconfirmed。
- Server：真实 Codex 连接本机模拟 Responses；两个 CODEX_HOME 的 JSONL 只含各自标记；bob 进程 SIGKILL 后 alice 完成；bob 下次请求重新启动并恢复；第五个用户回收最久空闲者；禁用 bob 后关闭其进程、旧令牌返回 401。该测试需要原生 Codex、PG、Redis、两个本机监听端口，不调用收费模型。
- Ports：继承的 HTTP/CLI、网关检查、媒体 HTTP、工具装载和 SSE 端口回归通过。

## Linux 容器 uid 与能力

准备 `.env` 和 `CONTAINER_APP_DIR` 后构建镜像；此项不启动 PG、Redis 或模型网关，不读取模型凭据：

```bash
docker compose build agent
docker compose run --rm --no-deps -T agent npm run test:runtimes:uid
```

预期 `CapEff` 仅包含 CHOWN、FOWNER、SETGID、SETUID，`NoNewPrivs=1`。子进程实际为 uid/gid 10001、10002，补充组不含 1000，三个用户根目录均为用户 uid:1000 / 2770；跨用户读取报 `EACCES`，新文件 0660，新子目录 2770。Codex 环境中没有数据库、Redis、服务商密钥或 NODE_OPTIONS。同 uid 信号发送器能关闭用户进程，不添加 KILL 或 DAC_OVERRIDE。

`compose.yaml` 的 agent 为 `user: "0:1000"`；不得用 `--privileged` 或额外 capability 使测试通过。容器内以非 root 执行 `npm run server` 应报“容器内无法切换系统用户，拒绝启动”，不降级。

## 服务器验收

默认部署目录 `/opt/s14-isolation`、域名 `example.com`、端口 4328、项目及 systemd 单元 `codex-harness-s14`、数据库 `agent_s14`。停服迁移与初始化后再启动 agent：

```bash
docker compose stop agent
docker compose run --rm --no-deps -T agent npm run data:migrate
docker compose run --rm --no-deps -T agent npm run agent:init
docker compose run --rm --no-deps agent npm run auth:init
docker compose run --rm --no-deps agent npm run user:add -- bob
docker compose up -d --wait agent
```

已有账号不要重复 auth:init。迁移可重复执行，日志会明确说明状态。账号禁用命令：

```bash
docker compose run --rm --no-deps agent npm run user:disable -- bob
```

连接服务器的两个终端分别用不同用户 `npm run login`。各自发送唯一的非敏感文本并记录 Thread ID。用以下只读 SQL 查看映射，再核对对应目录的 rollout：

```bash
docker compose exec -T postgres psql -U agent -d agent_s14 -c \
  'SELECT u.username,r.uid,r.codex_home FROM agent_data.user_runtimes r JOIN agent_data.users u ON u.instance_id=r.instance_id AND u.id=r.user_id ORDER BY r.uid'
```

预期每用户只有自己的 rollout；不要按绝对路径搬移 `.data/codex`。在允许原生记忆的 Agent 配置下启用服务端记忆，再改变 bob 会话的贡献开关，alice 的会话设置和目录不变；检查的是隔离与开关，不把“开启”当作“已生成摘要”。

在 alice、bob 各有执行中轮次时从宿主机终止 bob 的原生 Codex PID，核对只有 bob 的任务待核对，alice 正常完成。随后 bob 请求触发重启。再创建到第五个用户，观察最久空闲 PID 退出；全部忙的边界由离线测试覆盖（全局仅 2 轮，另两个可用排队任务保持忙）。禁用 bob 时不发下一次业务请求，直接观察其进程退出。

## 备份与回归

备份须停服，`codex.tar.gz` 同时包含 `.data/codex` 与 `.data/users`。保留 user_runtimes 数据库记录及其绝对路径；恢复不能改变用户 uid 映射。按原部署命令运行 `npm run backup` 和 `npm run restore -- <备份名>` 后，复核两个用户均能恢复原会话、目录属主仍不同。
