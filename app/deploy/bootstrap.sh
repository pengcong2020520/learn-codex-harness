#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/topology.sh
source deploy/env-run.sh
docker compose up -d etcd
docker compose stop "${cluster_nodes[@]}"
docker compose run --rm --no-deps -T etcd-init
docker compose up -d --wait etcd postgres redis gateway
# 网关在启动时读取配置；后续部署仍需加载刚生成的配置。
docker compose up -d --wait --force-recreate gateway
# 与 Compose 的初始化链共用迁移、agent:init 和身份复制。
docker compose run --rm --no-deps -T migrate
