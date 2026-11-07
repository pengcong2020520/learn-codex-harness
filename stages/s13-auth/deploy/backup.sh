#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
# The same inode is held by backup, restore and the entire rsync sender. Never unlink it.
exec 9>backups/.download.lock
flock -n 9 || { echo '已有备份、恢复或下载正在进行。' >&2; exit 75; }
partial=''
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$partial" ]; then rm -rf -- "$partial" || status=1; fi
  if ! docker compose up -d --wait agent; then
    echo 'agent 重启失败，请检查 docker compose ps。' >&2
    status=1
  fi
  exit "$status"
}
# Install before stop so even an interrupted/failed stop attempts to bring agent back.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose stop agent
name=$(date -u +%Y-%m-%dT%H-%M-%S-000Z)
[ ! -e "backups/$name" ] || { echo '备份名称已存在，请稍后重试。' >&2; exit 1; }
mkdir "backups/.$name.partial"
partial="backups/.$name.partial"
# Keep these arguments in sync with backup-lib.mjs dumpCommand(agent, agent_s13).
docker compose exec -T postgres pg_dump --no-password -U agent --clean --if-exists --no-owner --no-privileges agent_s13 |
  gzip > "$partial/database.sql.gz"
# The agent image runs as uid 1000; root-created private files must be writable there.
if [ "$(id -u)" = 0 ]; then chown 1000:1000 backups "$partial" "$partial/database.sql.gz"; fi
docker compose run --rm --no-deps -T agent node scripts/backup.mjs --apply --partial "$name"
