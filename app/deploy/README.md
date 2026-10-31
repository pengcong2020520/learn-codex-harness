# 部署到服务器

把 `app/` 作为常驻服务部署到一台 Linux 服务器（已在 Alibaba Cloud Linux 3 上验证）。服务**只监听服务器的 127.0.0.1**，不对公网开放；在本机用 SSH 隧道访问。

| 组件 | 服务器上的位置 | 常驻方式 |
|---|---|---|
| PostgreSQL / Redis | Docker 容器，`127.0.0.1:5432` / `6379` | `codex-harness-db.service` |
| Agent 服务 | `127.0.0.1:4317` | `codex-harness.service`（运行用户 `codex`） |
| Web 工作台与课程 | `127.0.0.1:14320` | `codex-harness-web.service`（运行用户 `codex`） |

三个单元都开机自启、失败后自动重启；5 分钟内失败 5 次就不再重启，避免启动即崩溃时无限重启占满 CPU（`systemctl reset-failed` 后可再启动）。

## 前提

- 服务器：Docker（含 compose v2）、Node.js 24+、rsync，可以用 SSH 密钥以 root 登录。
- 本机：仓库已克隆，`app/.env` 里有可用的模型配置；有 rsync、nc。

## 首次部署

```bash
export DEPLOY_HOST=root@<服务器地址>
app/deploy/remote.sh init-env   # 用本机的模型配置生成服务器 .env；数据库密码在服务器上新生成
app/deploy/remote.sh deploy     # 同步当前提交的 app/，安装依赖、迁移、启动常驻服务
```

`deploy` 只部署**已提交**的代码（`git archive HEAD`），服务器上的 `.env`、`.data/`、`.runs/`、`workspace/` 与 `node_modules/` 不会被覆盖或删除。可以重复运行，每次都会等到健康检查通过才返回。

## 日常使用

```bash
app/deploy/remote.sh status   # 版本、三个服务、容器与健康检查
app/deploy/remote.sh logs     # 跟随查看日志
app/deploy/remote.sh tunnel   # 前台隧道：浏览器打开 http://127.0.0.1:14320/
app/deploy/remote.sh chat     # 临时建隧道，用本机 CLI 连接服务器上的 Agent
```

本机隧道端口是 14317 / 14320，不占用本机运行的 4317 / 4320。工作台会校验 Host，所以服务器上的工作台端口与本机隧道端口相同（14320）。

## 注意

- 模型密钥在服务器的 `/opt/learn-codex-harness/app/.env`（权限 600，属主 `codex`）。更换密钥后执行 `systemctl restart codex-harness`。
- 数据在 Docker 数据卷 `codex-harness-app_postgres-data` / `codex-harness-app_redis-data` 里；不要运行 `docker compose down -v`。
- 服务端设置了 `NODE_ENV=production`，网页工具按严格的公网地址检查运行。
- 需要从浏览器直接访问域名时，要另外配 HTTPS 与登录认证，不能直接把这些端口暴露到公网。
