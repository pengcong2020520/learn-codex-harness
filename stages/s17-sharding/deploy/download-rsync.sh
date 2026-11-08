#!/usr/bin/env bash
# Invoked by rsync's SSH transport, not by HTTP. flock lives for the entire sender.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
exec 9>backups/.download.lock
flock -n 9 || { echo '已有下载、备份或恢复正在进行。' >&2; exit 75; }
# Never remove the shared lock file: closing fd 9 releases the kernel lock.
rsync "$@"
