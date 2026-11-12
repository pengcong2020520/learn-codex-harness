#!/usr/bin/env bash
# DEPLOY_HOST=example.com bash deploy/remote.sh check|init-env|deploy|auth-init|user -- add|passwd|disable|list [name]|status|tunnel|backup|backup-download [name]|rollback
set -euo pipefail
: "${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 example.com（SSH 配置别名也可）}"
APP_DIR=${APP_DIR:-/opt/codex-agent}
APP=$(cd "$(dirname "$0")/.." && pwd)
# Paths cross an SSH shell boundary. Keep the teaching interface deliberately narrow.
[[ "$APP_DIR" =~ ^/[a-zA-Z0-9_/-]+$ && "$APP_DIR" != / && "$APP_DIR" != *..* ]] || { echo 'APP_DIR 必须是无空格的绝对部署路径。' >&2; exit 1; }
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9_@.-]+$ && "$DEPLOY_HOST" != -* ]] || exit 1
remote() { ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; }
excludes=(--exclude=/.env --exclude=/.env.* --exclude=/nodes/ --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.git/)
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
  remote "APP_DIR='$APP_DIR' DEPLOY_HOST='$DEPLOY_HOST' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
exec 9> .deploy.lock
flock -n 9 || { echo '另一个部署正在进行。' >&2; exit 75; }
if [ -f REVISION ]; then
 mkdir -p "$APP_DIR.previous"
 rsync -a --delete --exclude=/.env --exclude=/nodes/ --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.deploy.lock ./ "$APP_DIR.previous/"
 if docker image inspect codex-agent:current >/dev/null 2>&1; then docker image tag codex-agent:current codex-agent:previous; fi
fi
touch .deploy-pending
# Fixed path: do not move mounted state or Codex absolute history paths.
rsync -a --delete --exclude=/.env --exclude=/nodes/ --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.deploy.lock --exclude=/.deploy-pending "$APP_DIR.incoming/" ./
bash deploy/server-setup.sh </dev/null
rm .deploy-pending
REMOTE
  ;;
 auth-init)
  # Interactive SSH must not share stdin with a heredoc. Only exit 3 means already initialized.
  ssh -t "$DEPLOY_HOST" "cd '$APP_DIR' && { docker compose run --rm --no-deps -v '$APP_DIR/.env:$APP_DIR/.env:ro' node-a node scripts/maintenance.mjs accounts init; code=\$?; [ \"\$code\" -eq 0 ] || [ \"\$code\" -eq 3 ] || exit \"\$code\"; }"
  remote "cd '$APP_DIR' && source deploy/topology.sh && docker compose up -d --wait \"\${cluster_nodes[@]}\" && bash deploy/enable-service.sh && bash deploy/cluster-ready.sh"
  ;;
 user)
  [[ "${2:-}" == -- ]] || { echo '用法：remote.sh user -- add|passwd|disable <name> | list' >&2; exit 1; }
  command=${3:-}
  case "$command" in
   add|passwd|disable)
    name=${4:-}
    [[ $# -eq 4 && "$name" =~ ^[a-z0-9_.-]{1,64}$ ]] || { echo '名称须为 1–64 位小写字母、数字、下划线、点或连字符。' >&2; exit 1; }
    ssh -t "$DEPLOY_HOST" "cd '$APP_DIR' && docker compose run --rm --no-deps -v '$APP_DIR/.env:$APP_DIR/.env:ro' node-a node scripts/maintenance.mjs accounts $command '$name'"
    ;;
   list)
    [[ $# -eq 3 ]] || { echo 'user list 不接受名称参数。' >&2; exit 1; }
    ssh -t "$DEPLOY_HOST" "cd '$APP_DIR' && docker compose run --rm --no-deps -v '$APP_DIR/.env:$APP_DIR/.env:ro' node-a node scripts/maintenance.mjs accounts list"
    ;;
   *) echo 'user 子命令必须为 add、passwd、disable 或 list。' >&2; exit 1 ;;
  esac
  ;;
 status) remote "cd '$APP_DIR' && cat REVISION && docker compose ps && bash deploy/cluster-ready.sh --check" ;;
 tunnel)
  local_port=$(node --input-type=module - "$APP/.env" <<'NODE'
import fs from 'node:fs';
import { parseEnv } from 'node:util';
let env = {};
try { env = parseEnv(fs.readFileSync(process.argv[2], 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = env.AGENT_PORT || '4317';
if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('AGENT_PORT 必须为 1–65535 的整数。'); process.exit(1);
}
console.log(Number(port));
NODE
  )
  target=$(remote "cd '$APP_DIR' && docker compose port caddy 80")
  [[ "$target" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo '服务器没有回环 Caddy 端口。' >&2; exit 1; }
  echo "本机 http://127.0.0.1:$local_port → 服务器 Caddy；Ctrl-C 关闭隧道。"
  exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L "$local_port:$target" "$DEPLOY_HOST"
  ;;
 backup) remote "cd '$APP_DIR' && bash deploy/backup.sh" ;;
 backup-download)
  name=${2:-}
  if [ -z "$name" ]; then
    name=$(remote "find '$APP_DIR/backups' -mindepth 3 -maxdepth 3 -name manifest.json -printf '%h\\n' | sort | tail -1 | xargs -r basename")
  fi
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$ ]] || { echo '没有可下载的备份或目录名无效。' >&2; exit 1; }
  mkdir -p ./backups
  # Server-side lock is acquired inside the actual rsync sender, no check/use gap.
  rsync -az --partial --bwlimit=200 --rsync-path="bash $APP_DIR/deploy/download-rsync.sh" \
    -e 'ssh -o BatchMode=yes' "$DEPLOY_HOST:$APP_DIR/backups/" ./backups/
  ;;
 rollback)
  remote "APP_DIR='$APP_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
exec 9> .deploy.lock
flock -n 9 || { echo '另一个部署正在进行。' >&2; exit 75; }
test -f "$APP_DIR.previous/REVISION" || { echo '没有上一版可回滚。' >&2; exit 1; }
docker image inspect codex-agent:previous >/dev/null
source deploy/topology.sh
docker compose stop "${cluster_nodes[@]}" </dev/null
rsync -a --delete --exclude=/.env --exclude=/nodes/ --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/backups/ --exclude=/node_modules/ --exclude=/.deploy.lock --exclude=/.deploy-pending "$APP_DIR.previous/" ./
docker image tag codex-agent:previous codex-agent:current
bash deploy/configure.sh </dev/null
docker compose up -d --wait --force-recreate gateway "${cluster_nodes[@]}" </dev/null
bash deploy/cluster-ready.sh </dev/null
rm -f .deploy-pending
cat REVISION
REMOTE
  ;;
 *) echo '用法：remote.sh check|init-env|deploy|auth-init|user -- add|passwd|disable <name>|user -- list|status|tunnel|backup|backup-download [名称]|rollback' >&2; exit 1 ;;
esac
