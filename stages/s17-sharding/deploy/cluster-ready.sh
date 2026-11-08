#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Caddy healthcheck tests /ready; node healthchecks test /health, including members still loading their shard maps.
case "${1:-}" in
 '') docker compose up -d --wait node-a node-b node-c caddy ;;
 --check) ;; # Status must not restart intentionally stopped members.
 *) echo '用法：cluster-ready.sh [--check]' >&2; exit 1 ;;
esac
docker compose exec -T caddy wget -q -O - http://127.0.0.1/ready
