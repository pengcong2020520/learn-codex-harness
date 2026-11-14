#!/usr/bin/env bash
# 端到端验收：在有 Docker 的机器上从零生成配置、构建并启动单节点脚手架，再检查账号、就绪、拓扑与会话。
# 只在干净的检出目录里运行（CI 或一次性测试机）：会在 app/ 下写 .env、.data/、nodes/，
# 结束时对独立的 Compose 项目执行 down -v，只删除这次验收自己的数据卷。
set -euo pipefail
cd "$(dirname "$0")/.."
[ ! -e .env ] || { echo "app/.env 已存在，拒绝覆盖：端到端验收只在干净的检出目录运行。" >&2; exit 1; }
# 独立的项目名，避免碰到同一台机器上真实部署的 codex-agent 数据卷。
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-codex-agent-e2e}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then echo "端到端验收失败；请核对上方步骤，不输出未经脱敏的容器日志。" >&2; fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  exit "$status"
}
trap cleanup EXIT

# 密码只在当前 shell 内存里生成；setup 不把它传入任何子进程环境或参数。
password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')
SETUP_ADMIN_PASSWORD="$password" CODEX_MODEL=deepseek/deepseek-flash DEEPSEEK_API_KEY=sk-e2e-placeholder \
  npm run setup -- --non-interactive

printf '%s\n' "$password" | node scripts/e2e-check.mjs
E2E_WEB_PASSWORD="$password" node --test tests/web-e2e.browser.mjs
npm run -s test:deploy:integration
# 只经 Compose 再起服务，核对同一账号仍能登录；扩容步骤保持独立。
docker compose stop
docker compose up -d --wait
printf '%s\n' "$password" | node scripts/e2e-check.mjs --login-only
SETUP_ADMIN_PASSWORD="$password" npm run cluster:enable -- --yes
echo "端到端验收通过：单节点上手、网页流程、三节点扩容与副本追平。"
