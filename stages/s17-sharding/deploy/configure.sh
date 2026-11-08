#!/usr/bin/env bash
# 临时生成器不是 agent：只有它以只读挂载读取 .env，结果仅含 env.* 引用。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data/gateway .runs workspace backups
# 不递归重置用户 uid；长期服务只接管自己的父目录。
if [ "$(id -u)" = 0 ]; then
  chown 0:1000 .data .data/gateway .runs workspace backups
  chmod 2770 .data .data/gateway .runs workspace backups
fi
for node in node-a node-b node-c; do
  mkdir -p "nodes/$node/.data" "nodes/$node/.runs" "nodes/$node/workspace" "backups/$node"
  if [ "$(id -u)" = 0 ]; then chown 0:1000 "nodes/$node/.data" "nodes/$node/.runs" "nodes/$node/workspace" "backups/$node"; fi
done
docker compose run --rm --no-deps --user 0 -T \
  -v "$PWD/.env:$PWD/.env:ro" -v "$PWD/.data/gateway:$PWD/.data/gateway" node-a node scripts/gateway-config.mjs
