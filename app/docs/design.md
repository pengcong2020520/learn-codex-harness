# HTTPS 与备份运维设计

## HTTPS 入口与生产检查

`edge` 只属于 `https` profile，使用与内部 `caddy` 相同 digest 的镜像，内存上限 64 MB，重启策略为 `unless-stopped`。用户主动填写域名才启用公网入口：发布 `0.0.0.0:80` 与 `0.0.0.0:443`，这是默认回环发布规则的唯一例外。内部入口仍为 `127.0.0.1:4317`。

`deploy/Caddyfile.edge` 从环境读取域名，反向代理到 `caddy:80`，保留 Host，`flush_interval -1` 让 SSE 及时发送，不启用请求体或 Authorization 日志。证书与配置分别保存在 `edge-data`、`edge-config` 命名卷。生产环境 `AGENT_TLS` 留空，Caddy 自动申请公网证书；`AGENT_TLS=internal` 只用于 CI 内部 CA 验收。

向导把 `https` 加入 `COMPOSE_PROFILES`，保留其他 profile 并去重。Compose 默认从工作目录 `.env` 读取该变量，逗号分隔多个 profile；shell 同名变量优先，使用时应避免意外覆盖。依据：[Compose 预定义环境变量](https://docs.docker.com/compose/how-tos/environment-variables/envvars/) 与 [插值优先级](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。开机自启脚本通过 `docker compose config --services` 获取实际启用服务，需要时启动 `edge`，仍以内部 Caddy 的 `/ready` 判定应用就绪。

`check` 属于 `tools` profile，显式执行 `docker compose run --rm check` 即可运行。它在 `CONTAINER_APP_DIR` 工作目录使用镜像内的代码和依赖，把宿主项目只读挂载到独立的 `/project`，支持宿主没有 Node.js 与依赖的部署。命令 `node scripts/production-check.mjs --root /project` 从该目录读取 `.env`、Agent 配置、`config/models.json` 和 `backups/`；`--root` 默认是项目根。部署目录检查在容器内比较 `.env` 的 `CONTAINER_APP_DIR` 与通过 `${PWD:-/nonexistent}` 传入的 `HOST_APP_DIR`，宿主模式仍与项目根比较。容器禁用网络、根文件系统只读，以 `0:1000` 运行，仅保留 `DAC_READ_SEARCH` 读取不同属主的 0600 配置和备份。

生产检查只有同时声明域名、启用 `https` profile、包含匹配 HTTPS origin 才将来源项标记为 ✓；仅有有效公网 HTTPS 来源时标记为 !，提示宿主反向代理或启用 profile。本地测试域名仍不算公网来源。此检查只检查配置，不判断 DNS、证书、代理运行状态和 CA 的可信度。

## 定时备份与保留

在部署目录执行 `sudo bash deploy/enable-backup-timer.sh` 安装并启用 `codex-agent-backup.timer`。timer 每天按服务器本地时间 04:00 调用 `bash deploy/backup.sh`，`Persistent=true` 补执行关机期间漏掉的任务。查看计划用 `systemctl list-timers codex-agent-backup.timer`，查看执行记录用 `journalctl -u codex-agent-backup.service`。

每个节点成功发布备份后，默认保留最近 7 份完整备份；`.env` 中的 `AGENT_BACKUP_KEEP` 可设为非负整数，0 表示不清理。备份容器按节点挂载目录，因此独立计算各节点份数。清理沿用备份过程持有的 `backups/.download.lock`，与恢复、整个下载过程互斥；锁文件不删除。只处理严格符合时间戳命名格式、manifest 与四个归档均为普通文件且大小匹配的目录，按名称倒序保留；`.partial`、符号链接、不完整备份、无关目录不清理。保留筛选不代替恢复前的 SHA-256 校验。
