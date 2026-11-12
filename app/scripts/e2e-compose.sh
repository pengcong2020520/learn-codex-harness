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
  if [ "$status" -ne 0 ]; then docker compose logs --tail 200 >&2 || true; fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  exit "$status"
}
trap cleanup EXIT

# 最小用户配置：模型名与一把占位密钥。本验收不调用模型，其余密钥全部随机生成。
printf 'CODEX_MODEL=deepseek/deepseek-flash\nDEEPSEEK_API_KEY=sk-e2e-placeholder\n' > .env
node scripts/deploy-env.mjs "$PWD" > .env.generated
mv .env.generated .env
chmod 600 .env

bash deploy/configure.sh
docker compose up -d --wait

password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')
printf 'admin\n%s\n' "$password" |
  docker compose run --rm --no-deps -T -v "$PWD/.env:$PWD/.env:ro" node-a node scripts/maintenance.mjs accounts init

node scripts/e2e-check.mjs "$password"
npm run -s test:deploy:integration
echo "端到端验收通过。"
