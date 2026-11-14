#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/topology.sh
umask 077
mkdir -p backups
if [ "$(id -u)" != 0 ] && [ ! -w backups ]; then
  echo '备份需要 root 权限（定时任务也以 root 运行）：请运行 sudo bash deploy/backup.sh' >&2
  exit 1
fi
# The same inode is held by backup, restore and the entire rsync sender. Never unlink it.
exec 9>backups/.download.lock
flock -n 9 || { echo '已有备份、恢复或下载正在进行。' >&2; exit 75; }
partial=''
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$partial" ]; then rm -rf -- "$partial" || status=1; fi
  if ! bash deploy/cluster-ready.sh; then
    echo 'agent 重启失败，请检查 docker compose ps。' >&2
    status=1
  fi
  exit "$status"
}
# Install before stop so even an interrupted/failed stop attempts to bring agent back.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose stop "${cluster_nodes[@]}"
name=$(date -u +%Y-%m-%dT%H-%M-%S-000Z)
for node in "${cluster_nodes[@]}"; do
  mkdir -p "backups/$node"
  [ ! -e "backups/$node/$name" ] || { echo '备份名称已存在。' >&2; exit 1; }
  partial="backups/$node/.$name.partial"
  mkdir "$partial"
  docker compose exec -T postgres pg_dump --no-password -U agent --clean --if-exists --no-owner --no-privileges agent | gzip > "$partial/database.sql.gz"
  if [ "$(id -u)" = 0 ]; then chown 0:1000 "backups/$node" "$partial" "$partial/database.sql.gz"; fi
  docker compose run --rm --no-deps -T --cap-add DAC_READ_SEARCH "$node" node scripts/backup.mjs --apply --partial "$name"
  partial=''
done
