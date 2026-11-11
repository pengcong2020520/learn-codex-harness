#!/usr/bin/env bash
# 在服务器上以 root 运行（由 remote.sh deploy 调用），可以重复执行。全部服务都在 Docker 里（compose.yaml），宿主只需要 Docker：
# 准备目录 → 构建镜像 → 启动基础服务与生成配置 → 停止阶段与工作台 → 下载模型
# → 启动阶段与工作台（阶段入口迁移与初始化）→ 安装开机单元 → 等健康检查通过。
set -euo pipefail
COURSE_DIR=${COURSE_DIR:-/opt/learn-codex-harness/course}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
cd "$COURSE_DIR"
test -f .env || { echo "缺少 $COURSE_DIR/.env，先在本机运行 remote.sh init-env。" >&2; exit 1; }
chmod 600 .env
# 阶段路径由 Compose 解析：优先沿用 CONTAINER_STAGES_DIR；旧部署缺少它时，
# 兼容 CONTAINER_APP_DIR 的同级 stages，保持 Codex 历史中的绝对路径。

# 要启动哪些可选服务写在 .env 的 COMPOSE_PROFILES 里，开机单元也靠它；填了 OLLAMA_BASE_URL 就带上本地向量模型。
ollama=no; grep -qE '^OLLAMA_BASE_URL=["'\'']?[^"'\''[:space:]]' .env && ollama=yes
grep -q '^COMPOSE_PROFILES=' .env || printf 'COMPOSE_PROFILES=app%s\n' "$([ "$ollama" = yes ] && echo ,embedding)" >> .env
compose() { docker compose "$@"; }
source deploy/tasks.sh

# 仅准备 course 数据与既有 stages-data；不改动旧部署的数据目录。
mkdir -p .data && chown -R 1000:1000 .data

for stage in s03-service s04-events-messages s05-agent-assembly s06-tools s07-memory s08-data-layer s09-knowledge-layer s10-skill-workflow s11-model-gateway; do
  mkdir -p "../stages-data/$stage/.data" "../stages-data/$stage/.runs" "../stages-data/$stage/workspace"
  chown -R 1000:1000 "../stages-data/$stage"
done
mkdir -p .data/stages && chown 1000:1000 .data/stages

echo "== 构建镜像"
if [ "${1:-}" != gateway ]; then compose build web stages; fi
# 从旧版部署升级（数据库与网关一个单元、智能体与工作台在宿主上直接跑 Node）：停掉并移除旧单元，否则旧进程占着端口；
# 数据卷与旧数据目录保留。
if [ -e "$UNIT_DIR/codex-harness-db.service" ] || [ -e "$UNIT_DIR/codex-harness-web.service" ]; then
  echo "== 停用旧版单元（宿主 Node 方式）"
  systemctl disable -q --now codex-harness-web.service codex-harness.service codex-harness-db.service || true
  rm -f "$UNIT_DIR/codex-harness-db.service" "$UNIT_DIR/codex-harness-web.service"
fi
echo "== 启动数据库、Redis 与模型网关"
compose up -d --wait postgres redis
echo "== 生成模型网关配置"
gateway_config
# 网关的配置库在临时目录，重建容器才会读到新配置。
compose up -d --wait --force-recreate gateway
if [ "$ollama" = yes ]; then compose up -d --wait ollama; fi
# 迁移不能与运行中的服务同时写状态（.data/server.lock），重复部署时先停阶段与工作台。
echo "== 停止阶段服务与工作台"
compose stop stages web
# run-stages 在每个阶段启动前执行对应 data:migrate / agent:init，不再迁移独立 Agent。
if [ "$ollama" = yes ]; then
  echo "== 下载向量模型（已下载的会跳过）"
  for model in $(s11_script ollama-pull.mjs --list); do compose exec -T ollama ollama pull "$model"; done
fi
# 旧结构里 app 的 agent 容器占着 127.0.0.1:14320 与 4317，新结构没有 agent 服务。
# 只停止并删除这一个容器（不带 -v），不动任何数据卷与 app/.data 等旧数据目录；不存在时跳过，可重复执行。
# 旧 stages/web 以 network_mode: service:agent 依附在 agent 上，先移除这两个（已停止的）容器，再删 agent。
old_agent=$(docker ps -aq --filter "label=com.docker.compose.project=codex-harness-app" --filter "label=com.docker.compose.service=agent")
if [ -n "$old_agent" ]; then
  echo "== 停用旧版 agent 容器"
  compose rm -f stages web
  docker rm -f $old_agent >/dev/null
fi
echo "== 启动阶段服务与工作台"
compose up -d --wait --wait-timeout 300 --force-recreate web stages

# 开机单元只负责开机时 docker compose up、关机时 stop；docker 路径换成这台服务器上的实际路径。
for unit in deploy/systemd/*.service; do
  sed -e "s#/usr/bin/docker#$(command -v docker)#g" -e "s#/opt/learn-codex-harness/course#$COURSE_DIR#g" "$unit" > "$UNIT_DIR/${unit##*/}"
  chmod 644 "$UNIT_DIR/${unit##*/}"
done
systemctl daemon-reload
systemctl enable -q codex-harness.service
systemctl start codex-harness.service

# 在 web 容器中验证课程 HTTP；阶段健康检查继续使用各阶段连接文件。
health() {
  compose exec -T web node -e '
    fetch("http://127.0.0.1:14320/api/bootstrap")
      .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));' 2>/dev/null
}
for _ in $(seq 1 60); do
  if health >/dev/null && compose exec -T stages node /opt/stages-deploy/run-stages.mjs --health; then
    echo "== 就绪：$(cat REVISION 2>/dev/null || echo 未知版本)"
    compose ps --format '{{.Service}} {{.Status}}' | paste -sd' ' -
    exit 0
  fi
  sleep 2
done
echo "服务没有在 120 秒内就绪，最近日志：" >&2
compose logs --tail 30 web stages >&2
exit 1
