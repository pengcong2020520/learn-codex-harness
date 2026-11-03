#!/usr/bin/env bash
# 在本机运行，管理部署在服务器上的 learn-codex-harness。服务只监听服务器的 127.0.0.1，通过 SSH 隧道访问。
#
# 用法：DEPLOY_HOST=root@<服务器地址> app/deploy/remote.sh <命令>
#   check     检查服务器是否满足部署条件（deploy 开始前也会自动检查）
#   init-env  用本机 app/.env 里的模型配置生成服务器 .env（已存在则不覆盖）；数据库密码和网关访问密钥在服务器上新生成
#   gateway   改了服务器 .env 里的模型或密钥后，重新生成网关配置并重启网关
#   deploy    部署当前提交的 app/，安装依赖、迁移并重启常驻服务
#   status    查看服务、容器、版本与健康检查
#   logs      跟随查看服务日志（Ctrl-C 退出）
#   tunnel    前台建立隧道：本机 14317 → Agent，14320 → Web 工作台
#   chat      临时建隧道，用本机 CLI 连接服务器上的 Agent
set -euo pipefail
: "${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 DEPLOY_HOST=root@1.2.3.4}"
APP_DIR=${APP_DIR:-/opt/learn-codex-harness/app}
APP=$(cd "$(dirname "$0")/.." && pwd)
AGENT_LOCAL=14317 WEB_PORT=14320
remote() { ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; }
forwards=(-L "$AGENT_LOCAL:127.0.0.1:4317" -L "$WEB_PORT:127.0.0.1:$WEB_PORT")
die() { echo "$1" >&2; exit 1; }
# 各家模型的密钥变量，与 config/models.json、compose.yaml 里的列表一致。
PROVIDER_KEYS='KIMI_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|XAI_API_KEY|ZHIPU_API_KEY|HUGGINGFACE_API_KEY'
need() { for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || die "本机缺少 ${tool}。"; done; }
reach() {
  need ssh
  remote true 2>/dev/null || die "无法用 SSH 密钥登录 ${DEPLOY_HOST}；先运行 ssh-copy-id ${DEPLOY_HOST}，确认 ssh $DEPLOY_HOST 不需要输入密码。"
}
preflight() { echo "检查服务器 ${DEPLOY_HOST}："; remote 'bash -s' < "$APP/deploy/check.sh"; }

case "${1:-}" in
  check)
    reach; preflight
    ;;
  init-env)
    test -f "$APP/.env" || die "本机没有 $APP/.env；先按 .env.example 填好模型配置。"
    # 服务器走模型网关：Codex 只连本机网关，各家密钥只交给网关（见 docs/model-gateway.md）。
    grep -qE "^CODEX_MODEL=[\"']?[a-z0-9_-]+/" "$APP/.env" || die "本机 app/.env 的 CODEX_MODEL 要写成“服务商/模型名”，如 kimi/kimi-k2.7-code。"
    grep -qE "^(${PROVIDER_KEYS})=[\"']?[^\"'[:space:]]" "$APP/.env" || die "本机 app/.env 里没有任何模型服务商的密钥（KIMI_API_KEY、DEEPSEEK_API_KEY 等）。"
    reach
    if remote "test -e '$APP_DIR/.env'"; then echo "服务器上已有 $APP_DIR/.env，未覆盖。"; exit 0; fi
    # 只带模型、各家密钥与 Agent 相关配置；密钥经 SSH 管道写入，不在终端显示。数据库密码与网关访问密钥在服务器上重新生成。
    grep -E "^(CODEX_MODEL[A-Z_]*|${PROVIDER_KEYS}|AGENT_MEMORY_[A-Z_]+|AGENT_DEFINITION|AGENT_TURN_TIMEOUT_MS|DEMO_TIMEOUT_MS)=" "$APP/.env" |
      remote "set -e; mkdir -p '$APP_DIR'; umask 077; pw=\$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n'); gw=\$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
        { cat; printf 'AGENT_PORT=4317\nAGENT_DB_PASSWORD=%s\nDATABASE_URL=postgresql://agent:%s@127.0.0.1:5432/agent\nREDIS_URL=redis://127.0.0.1:6379/0\nAGENT_GATEWAY_KEY=sk-bf-%s\n' \"\$pw\" \"\$pw\" \"\$gw\"; } > '$APP_DIR/.env'"
    echo "已生成服务器 $APP_DIR/.env（权限 600）。"
    ;;
  deploy)
    need git rsync
    ROOT=$(git -C "$APP" rev-parse --show-toplevel)
    rev=$(git -C "$ROOT" rev-parse --short HEAD)
    git -C "$ROOT" diff --quiet HEAD -- app || echo "提醒：app/ 有未提交的改动；只部署已提交的 ${rev}。"
    reach
    remote "test -f '$APP_DIR/.env'" || die "服务器上缺少 .env，先运行：$0 init-env"
    preflight || die "服务器不满足部署条件，按上面的提示处理后重试。"
    stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
    git -C "$ROOT" archive HEAD app | tar -x -C "$stage"
    echo "$rev" > "$stage/app/REVISION"
    # 只同步代码：.env、数据、运行记录、工作区与依赖目录留在服务器上，不被 --delete 删除。
    rsync -az --delete --exclude=/.env --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/node_modules/ \
      -e "ssh -o BatchMode=yes" "$stage/app/" "$DEPLOY_HOST:$APP_DIR/"
    remote "APP_DIR='$APP_DIR' bash '$APP_DIR/deploy/server-setup.sh'"
    ;;
  gateway)
    reach
    remote "cd '$APP_DIR' && runuser -u codex -- node scripts/gateway-config.mjs && docker compose up -d --wait --force-recreate gateway && systemctl restart codex-harness.service"
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
    need node nc
    token=$(remote "cat '$APP_DIR/.data/connection.json'" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')
    ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "${forwards[@]}" "$DEPLOY_HOST" & tunnel=$!
    trap 'kill $tunnel 2>/dev/null' EXIT
    for _ in $(seq 1 30); do nc -z 127.0.0.1 "$AGENT_LOCAL" 2>/dev/null && break; sleep 0.3; done
    AGENT_SERVER_URL="http://127.0.0.1:$AGENT_LOCAL" AGENT_SERVER_TOKEN="$token" node "$APP/client/main.mjs"
    ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
