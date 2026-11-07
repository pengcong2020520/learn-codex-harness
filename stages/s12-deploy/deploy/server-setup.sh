#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash deploy/check.sh
# Paths are validated by remote.sh. Never source .env as shell code.
docker compose build agent
bash deploy/configure.sh
docker compose up -d --wait postgres redis
docker compose up -d --wait --force-recreate gateway
docker compose stop agent
docker compose run --rm --no-deps -T agent npm run -s data:migrate
docker compose run --rm --no-deps -T agent npm run -s agent:init
docker compose up -d --wait --force-recreate agent
sed -e "s#@APP_DIR@#$PWD#g" -e "s#/usr/bin/docker#$(command -v docker)#g" \
 deploy/systemd/codex-harness-s12.service > /etc/systemd/system/codex-harness-s12.service
systemctl daemon-reload
systemctl enable --now codex-harness-s12.service
docker compose exec -T agent node deploy/ready.mjs
