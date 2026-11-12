#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/topology.sh
bash deploy/check.sh
# Paths are validated by remote.sh. Never source .env as shell code.
docker compose build "${cluster_nodes[@]}"
bash deploy/configure.sh --config-only
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
account_status=$(docker compose run --rm --no-deps -T node-a node scripts/accounts.mjs status)
case "$account_status" in
 uninitialized)
  echo "账号尚未初始化：运行 DEPLOY_HOST=${DEPLOY_HOST:-example.com} bash deploy/remote.sh auth-init"
  exit 0
  ;;
 initialized) ;;
 *) echo '无法识别账号初始化状态。' >&2; exit 1 ;;
esac
docker compose up -d --wait --force-recreate "${cluster_nodes[@]}" caddy
bash deploy/enable-service.sh
bash deploy/cluster-ready.sh
