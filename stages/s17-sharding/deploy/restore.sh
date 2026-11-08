#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name=${1:-}
[[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$ ]] || { echo '用法：restore.sh <备份目录名> [--yes]' >&2; exit 1; }
[[ $# -le 2 && ( $# -eq 1 || ${2:-} == --yes ) ]] || { echo '用法：restore.sh <备份目录名> [--yes]' >&2; exit 1; }
umask 077
mkdir -p backups
exec 9>backups/.download.lock
flock -n 9 || { echo '已有备份、恢复或下载正在进行。' >&2; exit 75; }
failed() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    # Also stop after a failed up/ready check, which may have started the service.
    if ! docker compose stop node-a node-b node-c; then echo '无法停止 agent，请立即人工停服。' >&2; fi
    echo '恢复未完成；agent 保持停止，请核对备份并重新恢复。' >&2
  fi
  exit "$status"
}
trap failed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose stop node-a node-b node-c
if [ "${2:-}" != --yes ]; then
  if ! { exec 8<>/dev/tty; } 2>/dev/null; then
    echo '恢复需要交互终端；非交互执行须显式传入 --yes。' >&2
    exit 1
  fi
  [ -t 8 ] || { echo '恢复需要交互终端或 --yes。' >&2; exit 1; }
  printf '将恢复 %s，覆盖数据库、workspace 和原生历史。输入 RESTORE：' "$name" >&8
  IFS= read -r answer <&8 || exit 1
  [ "$answer" = RESTORE ] || { echo '已取消恢复，agent 保持停止。' >&2; exit 1; }
  exec 8>&-
fi
for node in node-a node-b node-c; do
  docker compose run --rm --no-deps -T "$node" node scripts/restore.mjs --verify "$name"
done
# Keep these arguments in sync with backup-lib.mjs psqlCommand(agent, agent_s17).
gunzip -c "backups/node-a/$name/database.sql.gz" |
  docker compose exec -T postgres psql --no-password -U agent -d agent_s17 -X --set ON_ERROR_STOP=1 --single-transaction
# pg_dump --no-privileges does not restore runtime role grants. Reapply before restarting nodes.
docker compose run --rm --no-deps --user 0 -T -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/cluster-migrate.mjs
for node in node-a node-b node-c; do
  docker compose run --rm --no-deps -T --cap-add DAC_OVERRIDE "$node" node scripts/restore.mjs --files "$name"
done
docker compose up -d --wait node-a node-b node-c
bash deploy/cluster-ready.sh
echo '恢复完成，/ready 检查通过。'
