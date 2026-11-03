# 部署到服务器

把 `app/` 作为常驻服务部署到一台 Linux 服务器。**全部服务都在 Docker 里**（[compose.yaml](../compose.yaml)），宿主只需要 Docker；端口**只发布到服务器的 127.0.0.1**，不对公网开放，在本机用 SSH 隧道访问。

| 服务（compose） | 作用 | 宿主端口 | 何时启动 |
|---|---|---|---|
| `postgres` / `redis` | 数据库与队列 | `127.0.0.1:5432` / `6379` | 总是 |
| `gateway` | 模型网关（Bifrost），各家模型密钥只交给它 | `127.0.0.1:4330` | 总是 |
| `ollama` | 本地向量模型（RAG 用） | 不发布，网关经容器名访问 | 服务器 `.env` 填了 `OLLAMA_BASE_URL` |
| `agent` | Agent 服务（含 Codex） | `127.0.0.1:4317` | 总是 |
| `web` | Web 工作台与互动课程（与 `agent` 共用网络） | `127.0.0.1:14320` | 总是 |

`agent` 与 `web` 共用一个镜像，在服务器上构建（`Dockerfile`），容器里以 `node`（uid 1000）运行。`.data/`、`.runs/`、`workspace/` 挂载到宿主的部署目录，便于备份和迁移；PostgreSQL、Redis 与 Ollama 的数据在 Docker 数据卷里。

开机自启靠一个 systemd 单元 `codex-harness.service`：开机时 `docker compose up -d --wait`，关机时 `docker compose stop`。要启动哪些可选服务写在服务器 `.env` 的 `COMPOSE_PROFILES` 里（部署时自动写入）。网关、Ollama、智能体与工作台异常退出后由 Docker 自动重启。

## 准备

服务器需要：

| 要求 | 说明 |
|---|---|
| 使用 systemd 的 Linux | Debian / Ubuntu / RHEL 系均可 |
| Docker Engine + compose v2 | 国内服务器可用云厂商的 Docker 软件源，并在 `/etc/docker/daemon.json` 配置 `registry-mirrors` 加速拉取镜像 |
| rsync | 同步代码 |
| 资源 | 不启用 Ollama：磁盘剩余 ≥ 6 GB、可用内存 ≥ 800 MB，2 vCPU / 2 GiB 够用；启用 Ollama：磁盘 ≥ 12 GB、可用内存 ≥ 1500 MB，建议 4 GiB 内存 |
| 端口 | 4317、14320、5432、6379、4330 没有被其他程序占用（都只绑定 127.0.0.1） |
| SSH | 本机能用密钥以 root 登录：`ssh-copy-id root@<服务器地址>` |

宿主不需要装 Node：一次性任务（生成网关配置、迁移数据库、准备工作区）都用 `docker compose run` 在应用镜像里跑。实测空闲内存：agent 约 150 MB、网关约 125 MB、PostgreSQL 约 30 MB、Redis 与工作台各十几 MB；Ollama 加载向量模型时约 1.1 GB，空闲 5 分钟后卸载。

本机需要：已克隆的仓库、`app/.env` 里填好至少一家模型的密钥（如 `KIMI_API_KEY`）和 `CODEX_MODEL`（写成“服务商/模型名”，见 [模型网关](../docs/model-gateway.md)），以及 ssh、rsync、git；`chat` 还要 node 和 nc。

先检查服务器，缺什么会逐项说明怎么装：

```bash
export DEPLOY_HOST=root@<服务器地址>
app/deploy/remote.sh check
```

```text
检查服务器 root@<服务器地址>：
  ✓ systemd
  ✓ Docker 27.3.1
  ✓ Docker Compose version v2.29.7
  ✓ rsync
  ✓ 磁盘剩余 27 GB
  ✗ 可用内存 1200 MB
    → 至少需要 1500 MB：服务空闲约 350 MB，处理请求时约 600–800 MB；本地向量模型（Ollama）加载时还要约 1.1 GB。…
```

已经部署过、端口由本项目的容器占着时不算冲突，可以放心重复检查和部署。

## 首次部署

```bash
app/deploy/remote.sh init-env   # 用本机的模型配置生成服务器 .env；数据库密码和网关访问密钥在服务器上新生成
app/deploy/remote.sh deploy     # 检查服务器 → 同步当前提交的 app/ → 构建镜像、迁移，用 Docker 启动全部服务
```

`init-env` 只把模型与 Agent 相关的配置（`CODEX_MODEL`、各家模型密钥、`OLLAMA_BASE_URL`、`AGENT_MEMORY_*` 等）发到服务器，本机的数据库密码、端口和网关访问密钥不会带过去；服务器上已有 `.env` 时不覆盖。国内服务器构建镜像时可以换成国内源：

```bash
NPM_REGISTRY=https://registry.npmmirror.com APT_MIRROR=http://mirrors.tencentyun.com app/deploy/remote.sh init-env
```

`init-env` 还会写入 `CONTAINER_APP_DIR`（与部署路径相同）：容器里的项目路径和宿主一致，从旧服务器迁移过来的 Codex 会话记录（里面存的是绝对路径）才能接着用。

`deploy` 只部署**已提交**的代码（`git archive HEAD`），服务器上的 `.env`、`.data/`、`.runs/`、`workspace/` 不会被覆盖或删除。可以重复运行；每次都会先检查服务器，然后依次：构建镜像 → 生成网关配置 → 启动数据库、Redis、网关（与 Ollama）→ 停智能体与工作台 → 迁移数据库、准备工作区 → 下载向量模型（已下载的跳过）→ 启动智能体与工作台 → 安装开机单元，最后等到健康检查通过才返回。

从旧版部署（宿主上直接跑 Node、三个 systemd 单元）升级时，`deploy` 会停用并移除旧单元、删掉宿主上的 `node_modules/`，数据卷与 `.data/` 不动；旧的运行用户 `codex` 不再使用，可以自行删除。

## 日常使用

```bash
app/deploy/remote.sh check    # 部署条件
app/deploy/remote.sh status   # 版本、各容器状态、健康检查与内存
app/deploy/remote.sh logs     # 跟随查看容器日志
app/deploy/remote.sh tunnel   # 前台隧道：浏览器打开 http://127.0.0.1:14320/
app/deploy/remote.sh chat     # 临时建隧道，用本机 CLI 连接服务器上的 Agent
app/deploy/remote.sh gateway  # 改了服务器 .env 里的模型或密钥后：重新生成网关配置、重建网关并重启智能体
```

本机隧道端口是 14317 / 14320，不占用本机运行的 4317 / 4320。工作台会校验 Host，所以服务器上的工作台端口与本机隧道端口相同（14320）。

## 注意

- 模型密钥在服务器的 `/opt/learn-codex-harness/app/.env`（权限 600）。网关容器只收到各家密钥；智能体容器读整个 `.env`，但启动 Codex 前会去掉各家密钥，Codex 只拿到网关访问密钥。更换密钥或模型后运行 `remote.sh gateway`。
- 数据在 Docker 数据卷 `codex-harness-app_postgres-data` / `codex-harness-app_redis-data` / `codex-harness-app_ollama-data` 与部署目录的 `.data/` 里；不要运行 `docker compose down -v`。
- 镜像里设置了 `NODE_ENV=production`，网页工具按严格的公网地址检查运行。
- 需要从浏览器直接访问域名时，要另外配 HTTPS 与登录认证，不能直接把这些端口暴露到公网。
