#!/usr/bin/env bash
# 仅在账号初始化且 agent 启动成功后注册开机启动。
set -euo pipefail
cd "$(dirname "$0")/.."
sed -e "s#@APP_DIR@#$PWD#g" -e "s#/usr/bin/docker#$(command -v docker)#g" \
 deploy/systemd/codex-agent.service > /etc/systemd/system/codex-agent.service
systemctl daemon-reload
systemctl enable --now codex-agent.service
