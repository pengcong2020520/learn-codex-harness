#!/usr/bin/env bash
# 镜像内核对并安装包，由宿主 Compose 重建本项目，容器无需接触 Docker socket。
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--help" ]]; then
  echo '用法：bash deploy/land.sh [--package app 下的包目录]。默认选择唯一设计项目的最新包。'
  exit 0
fi
[[ -f .env ]] || { echo '请先在 app/ 完成本机配置。' >&2; exit 1; }
stage=校验与安装
trap 'echo "落地停在「$stage」。请核对 .land/receipt.json 与 docker compose ps，修正后手动继续。" >&2' ERR
docker compose run --rm --no-deps --build land "$@"
stage=关闭工作室校验服务
docker compose --profile studio rm --stop --force design-check
stage=重建并切换到产品
docker compose up -d --build --wait
stage=核对产品就绪与首页
docker compose exec -T node-a node scripts/design-land.mjs --verify-live
echo '产品已就绪。重新打开本机入口可进入产品，设计记录位于 design/。'
