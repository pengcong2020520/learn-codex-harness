#!/usr/bin/env bash
# 在部署目录安装，使用服务器本地时区；漏跑的任务由 systemd 补执行。
set -euo pipefail
cd "$(dirname "$0")/.."
sed -e "s#@APP_DIR@#$PWD#g" \
 deploy/systemd/codex-agent-backup.service > /etc/systemd/system/codex-agent-backup.service
cp deploy/systemd/codex-agent-backup.timer /etc/systemd/system/codex-agent-backup.timer
systemctl daemon-reload
systemctl enable --now codex-agent-backup.timer
