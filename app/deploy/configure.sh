#!/usr/bin/env bash
# 配置补齐与目录准备使用短命容器；长期 agent 不挂载 .env。
set -euo pipefail
cd "$(dirname "$0")/.."
# 原子替换需要挂载父目录；只给这个同 uid 的短命容器写权限。
preview_image=$(sed -n 's/^FROM //p' Dockerfile)
docker run --rm --network none --user 0 -v "$PWD:/app" -w /app "$preview_image" node scripts/ensure-preview-secret.mjs
source deploy/topology.sh
source deploy/env-run.sh
docker compose build "${cluster_nodes[@]}"
docker compose run --rm --no-deps -T prepare
if [ "${1:-}" != --config-only ]; then bash deploy/bootstrap.sh; fi
