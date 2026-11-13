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
compose_env_run --user 0 -T node-a node scripts/cluster-migrate.mjs
docker compose run --rm --no-deps -T node-a npm run -s agent:init
# 身份文件属于容器 root，宿主普通用户不能读取；复制也在一次性容器中完成。
docker compose run --rm --no-deps --user 0 -T -v "$PWD/nodes:/prepare-nodes" node-a sh -ec '
  for node in "$@"; do
    source=/prepare-nodes/node-a/.data/identity.json
    target=/prepare-nodes/$node/.data/identity.json
    if [ -f "$target" ]; then
      cmp "$source" "$target" || { echo "节点部署身份不一致。" >&2; exit 1; }
    else
      cp "$source" "$target"
      chmod 600 "$target"
    fi
  done
' sh "${cluster_nodes[@]:1}"
