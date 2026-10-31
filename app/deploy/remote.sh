#!/usr/bin/env bash
# 在本机运行，管理部署在服务器上的 learn-codex-harness。服务只监听服务器的 127.0.0.1，通过 SSH 隧道访问。
#
# 用法：DEPLOY_HOST=root@<服务器地址> app/deploy/remote.sh <命令>
#   init-env  用本机 app/.env 里的模型配置生成服务器 .env（已存在则不覆盖）；数据库密码在服务器上新生成
#   deploy    部署当前提交的 app/，安装依赖、迁移并重启常驻服务
#   status    查看服务、容器、版本与健康检查
#   logs      跟随查看服务日志（Ctrl-C 退出）
#   tunnel    前台建立隧道：本机 14317 → Agent，14320 → Web 工作台
#   chat      临时建隧道，用本机 CLI 连接服务器上的 Agent
set -euo pipefail
: "${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 DEPLOY_HOST=root@1.2.3.4}"
APP_DIR=${APP_DIR:-/opt/learn-codex-harness/app}
APP=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(git -C "$APP" rev-parse --show-toplevel)
AGENT_LOCAL=14317 WEB_PORT=14320
remote() { ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; }
forwards=(-L "$AGENT_LOCAL:127.0.0.1:4317" -L "$WEB_PORT:127.0.0.1:$WEB_PORT")

case "${1:-}" in
  init-env)
    if remote "test -e '$APP_DIR/.env'"; then echo "服务器上已有 $APP_DIR/.env，未覆盖。"; exit 0; fi
    # 只带模型与 Agent 相关配置；密钥经 SSH 管道写入，不在终端显示。数据库配置在服务器上重新生成。
    grep -E '^(CODEX_[A-Z_]+|AGENT_MEMORY_[A-Z_]+|AGENT_DEFINITION|AGENT_TURN_TIMEOUT_MS|DEMO_TIMEOUT_MS)=' "$APP/.env" |
      remote "set -e; mkdir -p '$APP_DIR'; umask 077; pw=\$(openssl rand -hex 24)
        { cat; printf 'AGENT_PORT=4317\nAGENT_DB_PASSWORD=%s\nDATABASE_URL=postgresql://agent:%s@127.0.0.1:5432/agent\nREDIS_URL=redis://127.0.0.1:6379/0\n' \"\$pw\" \"\$pw\"; } > '$APP_DIR/.env'"
    echo "已生成服务器 $APP_DIR/.env（权限 600）。"
    ;;
  deploy)
    rev=$(git -C "$ROOT" rev-parse --short HEAD)
    git -C "$ROOT" diff --quiet HEAD -- app || echo "提醒：app/ 有未提交的改动；只部署已提交的 $rev。"
    remote "test -f '$APP_DIR/.env'" || { echo "服务器上缺少 .env，先运行：$0 init-env" >&2; exit 1; }
    stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
    git -C "$ROOT" archive HEAD app | tar -x -C "$stage"
    echo "$rev" > "$stage/app/REVISION"
    # 只同步代码：.env、数据、运行记录、工作区与依赖目录留在服务器上，不被 --delete 删除。
    rsync -az --delete --exclude=/.env --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/node_modules/ \
      -e "ssh -o BatchMode=yes" "$stage/app/" "$DEPLOY_HOST:$APP_DIR/"
    remote "APP_DIR='$APP_DIR' bash '$APP_DIR/deploy/server-setup.sh'"
    ;;
  status)
    remote "cd '$APP_DIR' && echo \"版本：\$(cat REVISION)\" && systemctl --no-pager is-active codex-harness-db codex-harness codex-harness-web | paste -sd' ' - &&
      docker compose ps --format '{{.Name}}  {{.Status}}' && runuser -u codex -- node -e '
        const { url, token } = JSON.parse(require(\"fs\").readFileSync(\".data/connection.json\", \"utf8\"));
        fetch(url + \"/health\", { headers: { authorization: \"Bearer \" + token } }).then(r => r.json())
          .then(v => console.log(\"健康检查：\" + v.status + \"；模型：\" + v.model + \"；队列：\" + v.queueBackend));' &&
      free -h | sed -n 2p"
    ;;
  logs)
    ssh -t "$DEPLOY_HOST" "journalctl -u codex-harness -u codex-harness-web -u codex-harness-db -n 50 -f"
    ;;
  tunnel)
    echo "隧道已建立：Web 工作台 http://127.0.0.1:$WEB_PORT/ ，Agent http://127.0.0.1:$AGENT_LOCAL 。Ctrl-C 关闭。"
    exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "${forwards[@]}" "$DEPLOY_HOST"
    ;;
  chat)
    token=$(remote "cat '$APP_DIR/.data/connection.json'" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')
    ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "${forwards[@]}" "$DEPLOY_HOST" & tunnel=$!
    trap 'kill $tunnel 2>/dev/null' EXIT
    for _ in $(seq 1 30); do nc -z 127.0.0.1 "$AGENT_LOCAL" 2>/dev/null && break; sleep 0.3; done
    AGENT_SERVER_URL="http://127.0.0.1:$AGENT_LOCAL" AGENT_SERVER_TOKEN="$token" node "$APP/client/main.mjs"
    ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
