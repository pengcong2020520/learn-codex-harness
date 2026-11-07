#!/usr/bin/env bash
# 临时生成器不是 agent：只有它以只读挂载读取 .env，结果仅含 env.* 引用。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data/gateway .runs workspace backups
if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 .data .runs workspace backups; fi
docker compose run --rm --no-deps --user 0 -T \
  -v "$PWD/.env:$PWD/.env:ro" agent node scripts/gateway-config.mjs
