#!/usr/bin/env bash
# DEPLOY_HOST=example.com bash deploy/remote.sh check|init-env|deploy|status|tunnel|backup|backup-download [name]|rollback
set -euo pipefail
: "${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 example.com（SSH 配置别名也可）}"
APP_DIR=${APP_DIR:-/opt/s13-auth}
APP=$(cd "$(dirname "$0")/.." && pwd)
# Paths cross an SSH shell boundary. Keep the teaching interface deliberately narrow.
[[ "$APP_DIR" =~ ^/[a-zA-Z0-9_/-]+$ && "$APP_DIR" != / && "$APP_DIR" != *..* ]] || { echo 'APP_DIR 必须是无空格的绝对部署路径。' >&2; exit 1; }
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9_@.-]+$ && "$DEPLOY_HOST" != -* ]] || exit 1
remote() { ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; }
excludes=(--exclude=/.env --exclude=/.env.* --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.git/)
case "${1:-}" in
 check) remote 'bash -s' < "$APP/deploy/check.sh" ;;
 init-env)
  test -f "$APP/.env" || { echo '先在本阶段复制 .env.example 为 .env，填写服务商密钥。' >&2; exit 1; }
  # noclobber + umask: existing secrets are never overwritten.
  # Bootstrap uses the pinned Node image even before the agent image is built.
  image=$(sed -n 's/^FROM //p' "$APP/Dockerfile")
  docker run --rm --network none -v "$APP:/app:ro" -w /app "$image" node scripts/deploy-env.mjs "$APP_DIR" |
    remote "set -eu; mkdir -p '$APP_DIR'; umask 077; set -C; cat > '$APP_DIR/.env'"
  echo '已生成服务器 .env；已有文件会被拒绝，不回显内容。'
  ;;
 deploy)
  remote 'bash -s' < "$APP/deploy/check.sh"
  remote "test -f '$APP_DIR/.env' && test ! -e '$APP_DIR/.deploy-pending' && mkdir -p '$APP_DIR.incoming'" || { echo '先 init-env；失败部署请先 rollback。' >&2; exit 1; }
  rsync -az --no-owner --no-group --delete "${excludes[@]}" -e 'ssh -o BatchMode=yes' "$APP/" "$DEPLOY_HOST:$APP_DIR.incoming/"
  rev="$(git -C "$APP" rev-parse --short HEAD)-worktree-$(date -u +%Y%m%dT%H%M%SZ)"
  printf '%s\n' "$rev" | remote "cat > '$APP_DIR.incoming/REVISION'"
  remote "APP_DIR='$APP_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
exec 9> .deploy.lock
flock -n 9 || { echo '另一个部署正在进行。' >&2; exit 75; }
if [ -f REVISION ]; then
 mkdir -p "$APP_DIR.previous"
 rsync -a --delete --exclude=/.env --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.deploy.lock ./ "$APP_DIR.previous/"
 if docker image inspect codex-harness-s13:current >/dev/null 2>&1; then docker image tag codex-harness-s13:current codex-harness-s13:previous; fi
fi
touch .deploy-pending
# Fixed path: do not move mounted state or Codex absolute history paths.
rsync -a --delete --exclude=/.env --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.deploy.lock --exclude=/.deploy-pending "$APP_DIR.incoming/" ./
bash deploy/server-setup.sh </dev/null
rm .deploy-pending
REMOTE
  ;;
 status) remote "cd '$APP_DIR' && cat REVISION && docker compose ps && docker compose exec -T agent node deploy/ready.mjs" ;;
 tunnel)
  target=$(remote "cd '$APP_DIR' && docker compose port agent 4327")
  [[ "$target" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo '服务器没有回环 agent 端口。' >&2; exit 1; }
  echo '本机 http://127.0.0.1:4327 → 服务器 agent；Ctrl-C 关闭隧道。'
  exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L "4327:$target" "$DEPLOY_HOST"
  ;;
 backup) remote "cd '$APP_DIR' && bash deploy/backup.sh" ;;
 backup-download)
  name=${2:-}
  if [ -z "$name" ]; then
    name=$(remote "find '$APP_DIR/backups' -mindepth 2 -maxdepth 2 -name manifest.json -printf '%h\\n' | sort | tail -1 | xargs -r basename")
  fi
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$ ]] || { echo '没有可下载的备份或目录名无效。' >&2; exit 1; }
  mkdir -p ./backups
  # Server-side lock is acquired inside the actual rsync sender, no check/use gap.
  rsync -az --partial --bwlimit=200 --rsync-path="bash $APP_DIR/deploy/download-rsync.sh" \
    -e 'ssh -o BatchMode=yes' "$DEPLOY_HOST:$APP_DIR/backups/$name" ./backups/
  ;;
 rollback)
  remote "APP_DIR='$APP_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
exec 9> .deploy.lock
flock -n 9 || { echo '另一个部署正在进行。' >&2; exit 75; }
test -f "$APP_DIR.previous/REVISION" || { echo '没有上一版可回滚。' >&2; exit 1; }
docker image inspect codex-harness-s13:previous >/dev/null
docker compose stop agent </dev/null
rsync -a --delete --exclude=/.env --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.deploy.lock --exclude=/.deploy-pending "$APP_DIR.previous/" ./
docker image tag codex-harness-s13:previous codex-harness-s13:current
bash deploy/configure.sh </dev/null
docker compose up -d --wait --force-recreate gateway agent </dev/null
docker compose exec -T agent node deploy/ready.mjs </dev/null
rm -f .deploy-pending
cat REVISION
REMOTE
  ;;
 *) echo '用法：remote.sh check|init-env|deploy|status|tunnel|backup|backup-download [名称]|rollback' >&2; exit 1 ;;
esac
