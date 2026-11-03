#!/usr/bin/env bash
# 在服务器上以 root 运行（由 remote.sh deploy 调用），可以重复执行。全部服务都在 Docker 里（compose.yaml），宿主只需要 Docker：
# 准备数据目录 → 构建镜像 → 生成网关配置 → 启动数据库、Redis、网关（与 Ollama）→ 停智能体与工作台 → 迁移、准备工作区
# → 下载向量模型 → 启动智能体与工作台 → 安装开机单元 → 等健康检查通过。
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/learn-codex-harness/app}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
cd "$APP_DIR"
test -f .env || { echo "缺少 $APP_DIR/.env，先在本机运行 remote.sh init-env。" >&2; exit 1; }
chmod 600 .env

# 要启动哪些可选服务写在 .env 的 COMPOSE_PROFILES 里，开机单元也靠它；填了 OLLAMA_BASE_URL 就带上本地向量模型。
ollama=no; grep -qE '^OLLAMA_BASE_URL=["'\'']?[^"'\''[:space:]]' .env && ollama=yes
grep -q '^COMPOSE_PROFILES=' .env || printf 'COMPOSE_PROFILES=app%s\n' "$([ "$ollama" = yes ] && echo ,embedding)" >> .env
compose() { docker compose "$@"; }
# 一次性任务在智能体镜像里跑（不启动依赖、跑完即删），宿主不需要 Node。
in_app() { docker compose run --rm --no-deps -T agent "$@"; }

# 容器里以 node（uid 1000）运行，挂载的数据目录交给它。
mkdir -p .data .runs workspace && chown -R 1000:1000 .data .runs workspace

echo "== 构建镜像"
compose build agent
echo "== 生成模型网关配置"
in_app node scripts/gateway-config.mjs
# 从旧版部署升级（数据库与网关一个单元、智能体与工作台在宿主上直接跑 Node）：停掉并移除旧单元，否则旧进程占着端口；
# 宿主上的 node_modules 也不再需要。数据卷与 .data 不动。
if [ -e "$UNIT_DIR/codex-harness-db.service" ] || [ -e "$UNIT_DIR/codex-harness-web.service" ]; then
  echo "== 停用旧版单元（宿主 Node 方式）"
  systemctl disable -q --now codex-harness-web.service codex-harness.service codex-harness-db.service || true
  rm -f "$UNIT_DIR/codex-harness-db.service" "$UNIT_DIR/codex-harness-web.service"
  rm -rf node_modules
fi
echo "== 启动数据库、Redis 与模型网关"
compose up -d --wait postgres redis
# 网关的配置库在临时目录，重建容器才会读到新配置。
compose up -d --wait --force-recreate gateway
if [ "$ollama" = yes ]; then compose up -d --wait ollama; fi
# 迁移不能与运行中的服务同时写状态（.data/server.lock），重复部署时先停智能体与工作台。
echo "== 停止智能体服务与工作台"
compose stop agent web
echo "== 迁移数据库并准备工作区（只建 Agent 定义里声明的目录，不覆盖已有文件）"
in_app npm run -s data:migrate
in_app npm run -s agent:init
if [ "$ollama" = yes ]; then
  echo "== 下载向量模型（已下载的会跳过）"
  for model in $(in_app node scripts/ollama-pull.mjs --list); do compose exec -T ollama ollama pull "$model"; done
fi
echo "== 启动智能体服务与工作台"
compose up -d --wait --force-recreate agent web

# 开机单元只负责开机时 docker compose up、关机时 stop；docker 路径换成这台服务器上的实际路径。
for unit in deploy/systemd/*.service; do
  sed -e "s#/usr/bin/docker#$(command -v docker)#g" -e "s#/opt/learn-codex-harness/app#$APP_DIR#g" "$unit" > "$UNIT_DIR/${unit##*/}"
  chmod 644 "$UNIT_DIR/${unit##*/}"
done
systemctl daemon-reload
systemctl enable -q codex-harness.service
systemctl start codex-harness.service

# 服务启动后会写出新的 .data/connection.json；在智能体容器里用其中的令牌请求 /health。
health() {
  compose exec -T agent node -e '
    const { url, token } = JSON.parse(require("fs").readFileSync(".data/connection.json", "utf8"));
    fetch(url + "/health", { headers: { authorization: "Bearer " + token } })
      .then(r => r.json()).then(v => { console.log(v.status); process.exit(v.status === "ready" ? 0 : 1); })
      .catch(() => process.exit(1));' 2>/dev/null
}
for _ in $(seq 1 60); do
  if health >/dev/null; then
    echo "== 就绪：$(cat REVISION 2>/dev/null || echo 未知版本)"
    compose ps --format '{{.Service}} {{.Status}}' | paste -sd' ' -
    exit 0
  fi
  sleep 2
done
echo "服务没有在 120 秒内就绪，最近日志：" >&2
compose logs --tail 30 agent >&2
exit 1
