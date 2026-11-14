#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/topology.sh
# Caddy healthcheck tests /ready; node healthchecks test /health, including members still loading their shard maps.
case "${1:-}" in
 '')
   entry_services=(caddy)
   # Compose 自行合并 shell 与 .env 的 profiles；只读取服务名，避免输出插值后的密钥。
   enabled_services=$(docker compose config --services)
   if printf '%s\n' "$enabled_services" | grep -qx edge; then entry_services+=(edge); fi
   docker compose up -d --wait "${cluster_nodes[@]}" "${entry_services[@]}"
   ;;
 --check) ;; # Status must not restart intentionally stopped members.
 *) echo '用法：cluster-ready.sh [--check]' >&2; exit 1 ;;
esac
docker compose exec -T caddy wget -q -O - http://127.0.0.1/ready
