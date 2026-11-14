#!/usr/bin/env bash
# 只在独立的干净检出中验收；setup 与 up 不调用宿主 Node.js/npm，不调用真实模型。
set -euo pipefail
cd "$(dirname "$0")/.."
for entry in .env .data .runs nodes workspace backups; do
  [ ! -e "$entry" ] || { echo "app/$entry 已存在；只用 Docker 的验收需要干净检出。" >&2; exit 1; }
done
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-codex-agent-e2e-docker-only}
case "$COMPOSE_PROJECT_NAME" in codex-agent-e2e-*) ;; *) echo '验收项目名必须以 codex-agent-e2e- 开头。' >&2; exit 1 ;; esac
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo '只用 Docker 的验收失败，请核对上方步骤与以下初始化服务日志。' >&2
    # 初始化服务只打印本项目脚本的无密钥提示；长期服务可能包含敏感内容，不输出其日志。
    docker compose logs --no-color --tail 60 prepare etcd-init migrate || true
  fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  if [ -n "${check_dir:-}" ]; then rm -rf "$check_dir"; fi
  exit "$status"
}
trap cleanup EXIT
# 仅生成本次验收的假凭据；-e 只传变量名，值不进入命令行参数。
export SETUP_ADMIN_PASSWORD=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
export CODEX_MODEL=deepseek/deepseek-flash
export DEEPSEEK_API_KEY=sk-e2e-placeholder
docker compose run --rm -T -e SETUP_ADMIN_PASSWORD -e CODEX_MODEL -e DEEPSEEK_API_KEY setup --non-interactive
# 检查阶段允许宿主 Node.js；属主与权限必须在 Linux 的真实挂载上断言。
node --input-type=module <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const info = fs.statSync('.env');
assert.equal(info.uid, fs.statSync('.').uid, '.env 应属于项目目录属主');
assert.equal(info.gid, fs.statSync('.').gid, '.env 应使用项目目录属组');
assert.equal(info.mode & 0o777, 0o600, '.env 权限应为 0600');
assert.equal(fs.readFileSync('.env', 'utf8').includes(process.env.SETUP_ADMIN_PASSWORD), false, '明文密码不能落盘');
NODE
docker compose up -d --wait
printf '%s\n' "$SETUP_ADMIN_PASSWORD" | node scripts/e2e-check.mjs --login-only
count=$(docker compose exec -T postgres psql -U agent -d agent -Atc 'SELECT count(*) FROM agent_data.users WHERE username IS NOT NULL')
[ "$count" = 1 ] || { echo '首次启动后账号数量不是 1。' >&2; exit 1; }
docker compose stop
docker compose up -d --wait
printf '%s\n' "$SETUP_ADMIN_PASSWORD" | node scripts/e2e-check.mjs --login-only
count=$(docker compose exec -T postgres psql -U agent -d agent -Atc 'SELECT count(*) FROM agent_data.users WHERE username IS NOT NULL')
[ "$count" = 1 ] || { echo '再次启动后账号数量不是 1。' >&2; exit 1; }
# 在同一临时部署追加 HTTPS 配置；测试 CA 不用于公网，凭据仍不进入参数。
cat >> .env <<'ENV'
AGENT_DOMAIN=agent.localhost
AGENT_TLS=internal
COMPOSE_PROFILES=https
AGENT_ALLOWED_ORIGINS=http://127.0.0.1:4317,http://localhost:4317,https://agent.localhost
ENV
docker compose up -d --wait
# 域名无需公共 DNS；只在测试客户端忽略内部 CA 的信任错误。
deadline=$((SECONDS + 120))
while :; do
  code=$(curl -k -sS --max-time 10 --resolve agent.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://agent.localhost/ready) || code=000
  [ "$code" = 200 ] && break
  [ "$SECONDS" -lt "$deadline" ] || { echo 'HTTPS /ready 等待超时。' >&2; exit 1; }
  sleep 2
done
code=$(printf '%s\n' "$SETUP_ADMIN_PASSWORD" | node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify({ username: "admin", password: input.trimEnd() }));
' | curl -k -sS --resolve agent.localhost:443:127.0.0.1 -H 'Content-Type: application/json' -H 'Origin: https://agent.localhost' --data-binary @- -o /dev/null -w '%{http_code}' https://agent.localhost/auth/login)
[ "$code" = 200 ] || { echo 'HTTPS 管理员登录未返回 200。' >&2; exit 1; }
# 检查只读挂载的路径与宿主一致；本地测试域名故意不算公网 HTTPS 来源。
check_dir=$(mktemp -d)
check_production() {
  local container_status=0
  docker compose run --rm -T check > "$check_dir/container" || container_status=$?
  [ "$container_status" = 1 ] || { echo '生产检查退出码不符合预期。' >&2; return 1; }
  grep -q '^✓ CONTAINER_APP_DIR' "$check_dir/container"
  grep -q '^✓ .env 文件' "$check_dir/container"
  [ "$(grep -c '^✗' "$check_dir/container")" = 1 ]
  grep -q '^✗ AGENT_ALLOWED_ORIGINS' "$check_dir/container"
}
check_production
grep -q '^! 备份：没有找到完整备份记录。' "$check_dir/container"
bash deploy/backup.sh
check_production
grep -q '^✓ 备份：' "$check_dir/container"
docker compose exec -T node-a node --input-type=module -e '
  const { verifyManifest } = await import("./scripts/backup-lib.mjs");
  const fs = await import("node:fs");
  const names = fs.readdirSync("backups").filter(name => !name.startsWith("."));
  if (names.length !== 1) throw new Error("应生成一份完整备份");
  await verifyManifest("backups/" + names[0]);
'
bash deploy/cluster-ready.sh --check
code=$(curl -k -sS --resolve agent.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://agent.localhost/ready)
[ "$code" = 200 ] || { echo '备份后 HTTPS 服务未恢复就绪。' >&2; exit 1; }
rm -rf "$check_dir"
echo '只用 Docker 的验收通过：配置属主与 0600 权限、两次登录、唯一管理员、HTTPS 就绪与登录、容器生产检查、备份与恢复就绪。'
