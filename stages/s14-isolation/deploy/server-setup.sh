#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash deploy/check.sh
# Paths are validated by remote.sh. Never source .env as shell code.
docker compose build agent
bash deploy/configure.sh
docker compose up -d --wait postgres redis gateway
# 网关在启动时读取配置；后续部署仍需加载刚生成的配置。
docker compose up -d --wait --force-recreate gateway
docker compose stop agent
docker compose run --rm --no-deps -T agent npm run -s data:migrate
docker compose run --rm --no-deps -T agent npm run -s agent:init
account_status=$(docker compose run --rm --no-deps -T agent node scripts/accounts.mjs status)
case "$account_status" in
 uninitialized)
  echo "账号尚未初始化：运行 DEPLOY_HOST=${DEPLOY_HOST:-example.com} bash deploy/remote.sh auth-init"
  exit 0
  ;;
 initialized) ;;
 *) echo '无法识别账号初始化状态。' >&2; exit 1 ;;
esac
docker compose up -d --wait --force-recreate agent
bash deploy/enable-service.sh
docker compose exec -T agent node deploy/ready.mjs
