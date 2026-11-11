#!/usr/bin/env bash
# 在本机运行，管理部署在服务器上的 learn-codex-harness。服务只监听服务器的 127.0.0.1，通过 SSH 隧道访问。
#
# 用法：DEPLOY_HOST=root@<服务器地址> course/deploy/remote.sh <命令>
#   check     检查服务器是否满足部署条件（deploy 开始前也会自动检查）
#   init-env  用本机 course/.env 里的模型配置生成服务器 .env（已存在则不覆盖）；数据库密码和网关访问密钥在服务器上新生成。
#             国内服务器可以同时指定镜像源：NPM_REGISTRY=https://registry.npmmirror.com APT_MIRROR=http://mirrors.tencentyun.com remote.sh init-env
#   gateway   改了服务器 .env 里的模型或密钥后，重新生成网关配置并重启网关
#   deploy    部署 course/ 与 s03–s11（默认 HEAD，DEPLOY_SOURCE=worktree 可验收未提交改动）：服务器上构建镜像、迁移，并用 Docker 启动全部服务（宿主只需要 Docker）
#   status    查看版本、各容器状态、健康检查与内存
#   logs      跟随查看容器日志（Ctrl-C 退出）
#   tunnel    前台建立隧道：本机 14320 → Web 工作台
set -euo pipefail
: "${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 DEPLOY_HOST=root@example.com}"
DEPLOY_DIR=${DEPLOY_DIR:-/opt/learn-codex-harness}
COURSE_DIR=$DEPLOY_DIR/course
COURSE=$(cd "$(dirname "$0")/.." && pwd)
WEB_PORT=14320
remote() { ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; }
forwards=(-L "$WEB_PORT:127.0.0.1:$WEB_PORT")
die() { echo "$1" >&2; exit 1; }
# 各家模型的密钥变量，与 s11 的 config/models.json、compose.yaml 里的列表一致。
PROVIDER_KEYS='ARK_API_KEY|KIMI_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|XAI_API_KEY|ZHIPU_API_KEY|HUGGINGFACE_API_KEY'
need() { for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || die "本机缺少 ${tool}。"; done; }
reach() {
  need ssh
  remote true 2>/dev/null || die "无法用 SSH 密钥登录 ${DEPLOY_HOST}；先运行 ssh-copy-id ${DEPLOY_HOST}，确认 ssh $DEPLOY_HOST 不需要输入密码。"
}
# 部署前在服务器上执行 check.sh：磁盘剩余 ≥ 8 GB；可用内存 + 空闲 swap ≥ 2048 MB。
preflight() { echo "检查服务器 ${DEPLOY_HOST}："; remote "COURSE_DIR='$COURSE_DIR' bash -s" < "$COURSE/deploy/check.sh"; }

case "${1:-}" in
  check)
    reach; preflight
    ;;
  init-env)
    test -f "$COURSE/.env" || die "本机没有 $COURSE/.env；先按 .env.example 填好模型配置。"
    # 服务器走模型网关：Codex 只连本机网关，各家密钥只交给网关（见 s11 的模型网关说明）。
    grep -qE "^CODEX_MODEL=[\"']?[a-z0-9_-]+/" "$COURSE/.env" || die "本机 course/.env 的 CODEX_MODEL 要写成“服务商/模型名”，如 kimi/kimi-k2.7-code。"
    grep -qE "^(${PROVIDER_KEYS})=[\"']?[^\"'[:space:]]" "$COURSE/.env" || die "本机 course/.env 里没有任何模型服务商的密钥（KIMI_API_KEY、DEEPSEEK_API_KEY 等）。"
    reach
    if remote "test -e '$COURSE_DIR/.env'"; then echo "服务器上已有 $COURSE_DIR/.env，未覆盖。"; exit 0; fi
    # 从旧结构（app/）升级：沿用旧 .env，数据库密码与网关访问密钥必须和已有数据卷、网关配置一致，不能重新生成。
    if remote "test -f '$DEPLOY_DIR/app/.env'"; then
      remote "umask 077; mkdir -p '$COURSE_DIR' && cp '$DEPLOY_DIR/app/.env' '$COURSE_DIR/.env' && chmod 600 '$COURSE_DIR/.env'"
      echo "已从旧部署复制 $DEPLOY_DIR/app/.env 到 $COURSE_DIR/.env（沿用原数据库密码与网关访问密钥）。"; exit 0
    fi
    # 只带模型、各家密钥与 Agent 相关配置；密钥经 SSH 管道写入，不在终端显示。数据库密码与网关访问密钥在服务器上重新生成。
    # 容器里的项目路径与部署路径相同（CONTAINER_STAGES_DIR），迁移过来的 Codex 历史记录路径不变；本机启用了本地向量模型就一并带上。
    { grep -E "^(CODEX_MODEL[A-Z0-9_]*|${PROVIDER_KEYS}|OLLAMA_BASE_URL|AGENT_MEMORY_[A-Z_]+|AGENT_DEFINITION|AGENT_WEB_SEARCH|AGENT_TURN_TIMEOUT_MS|DEMO_TIMEOUT_MS)=" "$COURSE/.env"
      printf 'CONTAINER_STAGES_DIR=%s/stages\n' "$DEPLOY_DIR"
      if [ -n "${NPM_REGISTRY:-}" ]; then printf 'NPM_REGISTRY=%s\n' "$NPM_REGISTRY"; fi
      if [ -n "${APT_MIRROR:-}" ]; then printf 'APT_MIRROR=%s\n' "$APT_MIRROR"; fi; } |
      remote "set -e; mkdir -p '$COURSE_DIR'; umask 077; pw=\$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n'); gw=\$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
        { cat; printf 'AGENT_PORT=4317\nAGENT_DB_PASSWORD=%s\nDATABASE_URL=postgresql://agent:%s@127.0.0.1:5432/agent\nREDIS_URL=redis://127.0.0.1:6379/0\nAGENT_GATEWAY_KEY=sk-bf-%s\n' \"\$pw\" \"\$pw\" \"\$gw\"; } > '$COURSE_DIR/.env'"
    echo "已生成服务器 $COURSE_DIR/.env（权限 600）。"
    ;;
  deploy)
    need git rsync node tar
    ROOT=$(git -C "$COURSE" rev-parse --show-toplevel)
    rev=$(git -C "$ROOT" rev-parse --short HEAD)
    if [ "${DEPLOY_SOURCE:-head}" = head ]; then
      git -C "$ROOT" diff --quiet HEAD -- course stages || echo "提醒：有未提交改动；只部署已提交的 ${rev}，验收工作区请设置 DEPLOY_SOURCE=worktree。"
    fi
    reach
    # 首次迁移只补缺失目标；保留旧目录、密钥和所有数据卷。
    remote "set -eu
      mkdir -p '$COURSE_DIR'
      if [ ! -e '$COURSE_DIR/.env' ] && [ -f '$DEPLOY_DIR/app/.env' ]; then
        (umask 077; cp '$DEPLOY_DIR/app/.env' '$COURSE_DIR/.env')
        chmod 600 '$COURSE_DIR/.env'
      fi
      if [ ! -e '$COURSE_DIR/.data/gateway' ] && [ -d '$DEPLOY_DIR/app/.data/gateway' ]; then
        mkdir -p '$COURSE_DIR/.data'
        cp -a '$DEPLOY_DIR/app/.data/gateway' '$COURSE_DIR/.data/gateway'
      fi"
    remote "test -f '$COURSE_DIR/.env'" || die "服务器上缺少 .env，先运行：$0 init-env"
    preflight || die "服务器不满足部署条件，按上面的提示处理后重试。"
    stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
    node "$COURSE/deploy/package-deploy.mjs" "$ROOT" "$stage" "${DEPLOY_SOURCE:-head}"
    # 只同步代码：.env、数据、运行记录、工作区与依赖目录留在服务器上，不被 --delete 删除。
    rsync -az --delete --exclude=/.env --exclude=/.data/ --exclude=/.runs/ --exclude=/workspace/ --exclude=/node_modules/ \
      -e "ssh -o BatchMode=yes" "$stage/course/" "$DEPLOY_HOST:$COURSE_DIR/"
    # stages-data 与 stages 同级；--delete 的作用域只有阶段代码，不包含持久化数据。
    remote "mkdir -p '$COURSE_DIR/../stages'"
    rsync -az --delete -e "ssh -o BatchMode=yes" "$stage/stages/" "$DEPLOY_HOST:$COURSE_DIR/../stages/"
    # 旧 agent 容器在 server-setup.sh 里处理：先停掉并移除依附在它网络上的旧 stages/web，再删 agent。
    remote "COURSE_DIR='$COURSE_DIR' bash '$COURSE_DIR/deploy/server-setup.sh'"
    ;;
  gateway)
    reach
    remote "COURSE_DIR='$COURSE_DIR' bash '$COURSE_DIR/deploy/server-setup.sh' gateway"
    ;;
  status)
    remote "cd '$COURSE_DIR' && echo \"版本：\$(cat REVISION)；开机单元：\$(systemctl is-active codex-harness)\" &&
      docker compose ps --format '{{.Service}}  {{.Status}}' &&
      docker compose exec -T web node -e 'fetch(\"http://127.0.0.1:14320/api/bootstrap\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' &&
      docker compose exec -T stages node /opt/stages-deploy/run-stages.mjs --health; health_status=\$?;
      docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}' && free -h | sed -n 2p; exit \$health_status"
    ;;
  logs)
    ssh -t "$DEPLOY_HOST" "cd '$COURSE_DIR' && docker compose logs -f --tail 50"
    ;;
  tunnel)
    echo "隧道已建立：Web 工作台 http://127.0.0.1:$WEB_PORT/ 。Ctrl-C 关闭。"
    exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "${forwards[@]}" "$DEPLOY_HOST"
    ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
