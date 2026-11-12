#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/topology.sh
docker compose up -d etcd
docker compose stop "${cluster_nodes[@]}"
docker compose run --rm --no-deps -T etcd-init
docker compose up -d --wait etcd postgres redis gateway
# 网关在启动时读取配置；后续部署仍需加载刚生成的配置。
docker compose up -d --wait --force-recreate gateway
docker compose run --rm --no-deps --user 0 -T -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/cluster-migrate.mjs
docker compose run --rm --no-deps -T node-a npm run -s agent:init
# Copy only the deployment UUID identity; each node keeps independent user files.
for node in "${cluster_nodes[@]:1}"; do
  if [ -f "nodes/$node/.data/identity.json" ]; then
    cmp nodes/node-a/.data/identity.json "nodes/$node/.data/identity.json" || { echo '节点部署身份不一致。' >&2; exit 1; }
  else
    cp nodes/node-a/.data/identity.json "nodes/$node/.data/identity.json"
    chmod 600 "nodes/$node/.data/identity.json"
  fi
done
