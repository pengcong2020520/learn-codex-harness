# 部署到服务器

把 `app/` 作为常驻服务部署到一台 Linux 服务器（已在 Alibaba Cloud Linux 3 上验证）。服务**只监听服务器的 127.0.0.1**，不对公网开放；在本机用 SSH 隧道访问。

| 组件 | 服务器上的位置 | 常驻方式 |
|---|---|---|
| PostgreSQL / Redis | Docker 容器，`127.0.0.1:5432` / `6379` | `codex-harness-db.service` |
| 模型网关（Bifrost） | Docker 容器，`127.0.0.1:4330` | `codex-harness-db.service`（与数据服务一起启停） |
| Agent 服务 | `127.0.0.1:4317` | `codex-harness.service`（运行用户 `codex`） |
| Web 工作台与课程 | `127.0.0.1:14320` | `codex-harness-web.service`（运行用户 `codex`） |

三个单元都开机自启、失败后自动重启；5 分钟内失败 5 次就不再重启，避免启动即崩溃时无限重启占满 CPU（`systemctl reset-failed` 后可再启动）。

## 准备

服务器需要：

| 要求 | 说明 |
|---|---|
| 使用 systemd 的 Linux | 已在 Alibaba Cloud Linux 3 上验证；Debian / Ubuntu / RHEL 系同理 |
| Docker Engine + compose v2 | 运行 PostgreSQL / Redis 与模型网关 |
| Node.js 24+ | 装在系统路径（`/usr/bin` 或 `/usr/local/bin`），不要用只对某个用户生效的 nvm |
| rsync | 同步代码 |
| 资源 | 磁盘剩余 ≥ 3 GB，可用内存 ≥ 800 MB（其中模型网关约 200 MB）；2 vCPU / 2 GiB 的机器够用 |
| 端口 | 4317、14320、5432、6379、4330 没有被其他程序占用（都只绑定 127.0.0.1） |
| SSH | 本机能用密钥以 root 登录：`ssh-copy-id root@<服务器地址>` |

本机需要：已克隆的仓库、`app/.env` 里填好至少一家模型的密钥（如 `KIMI_API_KEY`）和 `CODEX_MODEL`（写成“服务商/模型名”，见 [模型网关](../docs/model-gateway.md)），以及 ssh、rsync、git；`chat` 还要 node 和 nc。

先检查服务器，缺什么会逐项说明怎么装：

```bash
export DEPLOY_HOST=root@<服务器地址>
app/deploy/remote.sh check
```

```text
检查服务器 root@<服务器地址>：
  ✓ systemd
  ✓ Docker 26.1.3
  ✓ Docker Compose version v2.27.0
  ✗ 需要 Node.js 24+（当前：未安装）
    → https://nodejs.org/en/download；RHEL 系：curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - && dnf install -y nodejs；…
  ✓ rsync
  ✓ 磁盘剩余 27 GB
  ✓ 可用内存 1356 MB
```

已经部署过、端口由本服务自己占着时不算冲突，可以放心重复检查和部署。

## 首次部署

```bash
app/deploy/remote.sh init-env   # 用本机的模型配置生成服务器 .env；数据库密码和网关访问密钥在服务器上新生成
app/deploy/remote.sh deploy     # 检查服务器 → 同步当前提交的 app/ → 安装依赖、迁移、启动常驻服务
```

`init-env` 只把模型与 Agent 相关的配置（`CODEX_MODEL`、各家模型密钥、`AGENT_MEMORY_*` 等）发到服务器，本机的数据库密码、端口和网关访问密钥不会带过去；服务器上已有 `.env` 时不覆盖。

`deploy` 只部署**已提交**的代码（`git archive HEAD`），服务器上的 `.env`、`.data/`、`.runs/`、`workspace/` 与 `node_modules/` 不会被覆盖或删除。可以重复运行，每次都会先检查服务器、重新生成网关配置，最后等到健康检查通过才返回。systemd 单元里的 node、docker 路径在安装时换成服务器上的实际路径。

## 日常使用

```bash
app/deploy/remote.sh check    # 部署条件
app/deploy/remote.sh status   # 版本、三个服务、容器与健康检查
app/deploy/remote.sh logs     # 跟随查看日志
app/deploy/remote.sh tunnel   # 前台隧道：浏览器打开 http://127.0.0.1:14320/
app/deploy/remote.sh chat     # 临时建隧道，用本机 CLI 连接服务器上的 Agent
app/deploy/remote.sh gateway  # 改了服务器 .env 里的模型或密钥后：重新生成网关配置、重建网关并重启服务
```

本机隧道端口是 14317 / 14320，不占用本机运行的 4317 / 4320。工作台会校验 Host，所以服务器上的工作台端口与本机隧道端口相同（14320）。

## 注意

- 模型密钥在服务器的 `/opt/learn-codex-harness/app/.env`（权限 600，属主 `codex`），只传给网关容器，不进 Codex。更换密钥或模型后运行 `remote.sh gateway`。
- 数据在 Docker 数据卷 `codex-harness-app_postgres-data` / `codex-harness-app_redis-data` 里；不要运行 `docker compose down -v`。
- 服务端设置了 `NODE_ENV=production`，网页工具按严格的公网地址检查运行。
- 需要从浏览器直接访问域名时，要另外配 HTTPS 与登录认证，不能直接把这些端口暴露到公网。
