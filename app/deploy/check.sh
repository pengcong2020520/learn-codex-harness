#!/usr/bin/env bash
set -euo pipefail
for tool in docker systemctl rsync flock tar gzip sha256sum; do
  command -v "$tool" >/dev/null || { echo "缺少 $tool" >&2; exit 1; }
done
docker info >/dev/null
docker compose version
[ "$(id -u)" = 0 ] || { echo '远程部署使用有管理权限的 SSH 用户（安装 systemd 单元）。' >&2; exit 1; }
echo '检查通过；请自行确认磁盘、模型连通性及容器内存足够。'
