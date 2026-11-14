# HTTPS 与备份运维设计

## 服务器安装器

`deploy/install.sh` 只部署脚本所属检出的 `app/`，不克隆代码，也不支持管道下载执行。要求 root、Ubuntu 22.04/24.04 或 Debian 12，架构为 amd64/arm64；低于 2 GB 内存或 10 GB 可用磁盘仅提示，不自动增加 swap。基础软件只补齐 ca-certificates、curl、gnupg、util-linux、tar、gzip。

Docker 与 Compose 可用时跳过安装；否则使用 apt 仓库、`/etc/apt/keyrings/docker.asc` 和 `docker.sources`，安装 docker-ce、docker-ce-cli、containerd.io、docker-buildx-plugin、docker-compose-plugin，再启用 Docker。仓库配置依据 [Docker Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/) 和 [Debian 安装文档](https://docs.docker.com/engine/install/debian/)。`--cn` 将仓库及密钥切换到阿里云同名路径；`--registry-mirror` 只在 daemon.json 不存在时写入并重启 Docker，已有文件只给手动合并说明。

向导通过 `/dev/tty` 交互；`--non-interactive` 使用环境变量并关闭 TTY。凭据只按变量名传给容器。向导将用户名单独写入 `.data/setup-summary.json`（0600），安装器通过只读 check 容器读取汇总；不读取、source 或打印 `.env`。缺少历史汇总时提示使用已有管理员账号，不猜测用户名。Compose 自行读取 profiles；启用 edge 且 ufw 活动时放行 80/443。安装器与远程部署使用相同的 app 目录结构和 systemd 安装脚本，`.env`、`nodes/`、`.data/`、`backups/` 原地保留；远程部署默认目录不同，切换方式时须将 `APP_DIR` 指向同一 app 目录，不可移动已部署目录。

启动使用 `docker compose up -d --build --wait`。检查结果非零时保留该退出码并打印访问信息，不宣称生产检查通过；没有域名或使用 CI 本地域名时，现有来源检查会返回 1。CI 严格核对唯一错误为本地域名来源，同时验证 HTTPS 就绪、登录、唯一管理员与 systemd。内部 CA 通过测试环境变量生效，systemd 的测试 drop-in 只用于保持独立验收项目及内部 CA，不用于生产。

`--upgrade` 拒绝有本地改动的 Git 工作区，执行 `git pull --ff-only` 后重新加载安装器。`--install-docker-only` 只执行 Docker 安装（包含下载密钥所需基础工具），验证客户端与 Compose，不调用 systemd 或启动 dockerd；CI 在全新系统容器中禁止软件包安装钩子启动服务。

## HTTPS 入口与生产检查

`edge` 只属于 `https` profile，使用与内部 `caddy` 相同 digest 的镜像，内存上限 64 MB，重启策略为 `unless-stopped`。用户主动填写域名才启用公网入口：发布 `0.0.0.0:80` 与 `0.0.0.0:443`，这是默认回环发布规则的唯一例外。内部入口仍为 `127.0.0.1:4317`。

`deploy/Caddyfile.edge` 从环境读取域名，反向代理到 `caddy:80`，保留 Host，`flush_interval -1` 让 SSE 及时发送，不启用请求体或 Authorization 日志。证书与配置分别保存在 `edge-data`、`edge-config` 命名卷。生产环境 `AGENT_TLS` 留空，Caddy 自动申请公网证书；`AGENT_TLS=internal` 只用于 CI 内部 CA 验收。

向导把 `https` 加入 `COMPOSE_PROFILES`，保留其他 profile 并去重。Compose 默认从工作目录 `.env` 读取该变量，逗号分隔多个 profile；shell 同名变量优先，使用时应避免意外覆盖。依据：[Compose 预定义环境变量](https://docs.docker.com/compose/how-tos/environment-variables/envvars/) 与 [插值优先级](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。开机自启脚本通过 `docker compose config --services` 获取实际启用服务，需要时启动 `edge`，仍以内部 Caddy 的 `/ready` 判定应用就绪。

`check` 属于 `tools` profile，显式执行 `docker compose run --rm check` 即可运行。它在 `CONTAINER_APP_DIR` 工作目录使用镜像内的代码和依赖，把宿主项目只读挂载到独立的 `/project`，支持宿主没有 Node.js 与依赖的部署。命令 `node scripts/production-check.mjs --root /project` 从该目录读取 `.env`、Agent 配置、`config/models.json` 和 `backups/`；`--root` 默认是项目根。部署目录检查在容器内比较 `.env` 的 `CONTAINER_APP_DIR` 与通过 `${PWD:-/nonexistent}` 传入的 `HOST_APP_DIR`，宿主模式仍与项目根比较。容器禁用网络、根文件系统只读，以 `0:1000` 运行，仅保留 `DAC_READ_SEARCH` 读取不同属主的 0600 配置和备份。

生产检查只有同时声明域名、启用 `https` profile、包含匹配 HTTPS origin 才将来源项标记为 ✓；仅有有效公网 HTTPS 来源时标记为 !，提示宿主反向代理或启用 profile。本地测试域名仍不算公网来源。此检查只检查配置，不判断 DNS、证书、代理运行状态和 CA 的可信度。

## 定时备份与保留

在部署目录执行 `sudo bash deploy/enable-backup-timer.sh` 安装并启用 `codex-agent-backup.timer`。timer 每天按服务器本地时间 04:00 调用 `bash deploy/backup.sh`，`Persistent=true` 补执行关机期间漏掉的任务。查看计划用 `systemctl list-timers codex-agent-backup.timer`，查看执行记录用 `journalctl -u codex-agent-backup.service`。

每个节点成功发布备份后，默认保留最近 7 份完整备份；`.env` 中的 `AGENT_BACKUP_KEEP` 可设为非负整数，0 表示不清理。备份容器按节点挂载目录，因此独立计算各节点份数。清理沿用备份过程持有的 `backups/.download.lock`，与恢复、整个下载过程互斥；锁文件不删除。只处理严格符合时间戳命名格式、manifest 与四个归档均为普通文件且大小匹配的目录，按名称倒序保留；`.partial`、符号链接、不完整备份、无关目录不清理。保留筛选不代替恢复前的 SHA-256 校验。
