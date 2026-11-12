# Codex Agent

以教程 s18 为内核的通用云端 Agent 脚手架，默认单节点，可打开三节点集群。

本机需要 Docker Compose，终端客户端需要 Node.js 24。进入 `app/` 后，复制 `.env.example` 为 `.env`，填写服务商密钥、网关密钥、数据库与 Redis 密码、etcd 管理/健康/节点 A 密码，以及节点 A 的密钥和 SHA-256 哈希。`CONTAINER_APP_DIR` 填当前部署目录的绝对路径，后续保持不变。

```bash
cp .env.example .env
# 填写 .env；节点密钥至少 24 位，数据库节点密码只用字母、数字、下划线或连字符。
bash deploy/configure.sh
docker compose up -d --wait
```

configure 会构建镜像、生成网关配置、启动基础服务、迁移数据库并准备部署身份。首次启动尚无账号时，容器健康只表示进程存活，业务 `/ready` 会等待账号初始化。

```bash
# 账号维护仅在临时容器里读取管理员数据库凭据；密码交互输入。
docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts init
docker compose run --rm --no-deps -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts add alice
npm ci
export AGENT_SERVER_URL=http://127.0.0.1:4317
npm run login
npm run chat
npm run cluster -- status
```

上述维护命令分别执行 `auth:init`、`user:add` 对应的账号脚本；长期节点只有受限数据库权限，不能直接在运行中的节点执行账号维护。初始化后等待 `/ready` 返回 200。

打开集群：在 `.env` 同时设置以下两项，补齐 B/C 密钥、哈希与数据库/etcd 密码，再执行配置与启动：

```dotenv
AGENT_CLUSTER_NODES=node-a,node-b,node-c
COMPOSE_PROFILES=cluster
```

```bash
bash deploy/configure.sh
docker compose --profile cluster up -d --wait
```

也支持前缀 `node-a,node-b`；两节点时用 `docker compose --profile cluster up -d --wait node-a node-b caddy`，显式选择节点，依赖服务会自动启动。所有节点必须采用相同配置；扩容只补副本，不自动迁移主节点。单节点状态显示 `replication: "off"`。已有分片主节点或副本不在配置中时会拒绝启动。

课程网站见 [course](../course/)，各章快照见 [stages](../stages/)。
