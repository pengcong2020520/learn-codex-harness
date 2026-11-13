#!/usr/bin/env bash
# 临时生成器不是 agent：只有它以只读挂载读取 .env，结果仅含 env.* 引用。
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/topology.sh
source deploy/env-run.sh
docker compose build "${cluster_nodes[@]}"
# 宿主只创建挂载点；容器以相同的 root/1000 身份准备目录，不依赖宿主 uid。
mkdir -p .data .runs workspace backups nodes
for node in "${cluster_nodes[@]}"; do
  mkdir -p "nodes/$node/.data" "nodes/$node/.runs" "nodes/$node/workspace"
done
docker compose run --rm --no-deps --user 0 -T -v "$PWD:/prepare" node-a sh -ec '
  cd /prepare
  prepare() {
    test ! -L "$1" || { echo "数据目录不能是符号链接。" >&2; exit 1; }
    mkdir -p "$1"
    chown 0:1000 "$1" && chmod 2770 "$1"
  }
  # 不递归重置用户 uid；长期服务只接管自己的父目录。
  for directory in .data .runs workspace backups; do prepare "$directory"; done
  prepare .data/gateway
  for node in "$@"; do
    for directory in .data .runs workspace; do prepare "nodes/$node/$directory"; done
    prepare "backups/$node"
  done
' sh "${cluster_nodes[@]}"
compose_env_run --user 0 -T \
  -v "$PWD/.data/gateway:$PWD/.data/gateway" node-a node scripts/gateway-config.mjs
if [ "${1:-}" != --config-only ]; then bash deploy/bootstrap.sh; fi
