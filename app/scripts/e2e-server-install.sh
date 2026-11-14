#!/usr/bin/env bash
# 只在一次性 Linux runner 的干净检出中运行，不调用真实模型。
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo '服务器安装验收需要 root。' >&2; exit 1; }
for entry in .env .data .runs nodes workspace backups; do
  [ ! -e "$entry" ] || { echo '服务器安装验收需要干净检出。' >&2; exit 1; }
done
for unit in codex-agent.service codex-agent-backup.service codex-agent-backup.timer; do
  [ ! -e "/etc/systemd/system/$unit" ] && [ ! -e "/etc/systemd/system/$unit.d" ] || { echo '已有部署单元，拒绝覆盖；请使用一次性 runner。' >&2; exit 1; }
done
export COMPOSE_PROJECT_NAME=codex-agent-e2e-server-install
export SETUP_ADMIN_PASSWORD=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
export CODEX_MODEL=deepseek/deepseek-flash DEEPSEEK_API_KEY=sk-e2e-placeholder
export SETUP_DOMAIN=agent.localhost AGENT_TLS=internal
check_dir=$(mktemp -d)
cleanup() {
  status=$?
  # 先停 timer，避免清理过程中开始备份；只删除本次验收的独立项目卷。
  systemctl disable --now codex-agent-backup.timer codex-agent.service >/dev/null 2>&1 || true
  systemctl stop codex-agent-backup.service >/dev/null 2>&1 || true
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  for unit in codex-agent.service codex-agent-backup.service codex-agent-backup.timer; do
    rm -f "/etc/systemd/system/$unit"
  done
  rm -rf /etc/systemd/system/codex-agent.service.d /etc/systemd/system/codex-agent-backup.service.d
  systemctl daemon-reload
  sed -i '/# codex-agent-e2e-server-install$/d' /etc/hosts
  rm -f .env
  rm -rf "$check_dir"
  exit "$status"
}
trap cleanup EXIT
# systemd 不继承调用 shell；测试专用 drop-in 保持独立项目和内部 CA。
for unit in codex-agent.service codex-agent-backup.service; do
  mkdir -p "/etc/systemd/system/$unit.d"
  cat > "/etc/systemd/system/$unit.d/e2e.conf" <<EOF
[Service]
Environment=COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
Environment=AGENT_TLS=internal
EOF
done
printf '127.0.0.1 agent.localhost # codex-agent-e2e-server-install\n' >> /etc/hosts
for pass in 1 2; do
  install_status=0
  bash deploy/install.sh --non-interactive > "$check_dir/install-$pass" 2>&1 || install_status=$?
  cat "$check_dir/install-$pass"
  # 本地域名的生产检查有待处理项，部署仍应正常完成。
  [ "$install_status" = 0 ]
  [ "$(grep -c '^✗' "$check_dir/install-$pass")" = 1 ]
  grep -q '^✗ AGENT_ALLOWED_ORIGINS' "$check_dir/install-$pass"
  grep -Fxq '部署已完成；生产检查有 1 项需要在正式上线前处理（见上方 ✗），处理后运行 docker compose run --rm check 复查' "$check_dir/install-$pass"
  grep -q '^管理员用户名（向导记录）：admin$' "$check_dir/install-$pass"
  grep -q '^日志：docker compose logs -f$' "$check_dir/install-$pass"
  if [ "$pass" = 1 ]; then
    grep -q '^向导完成。$' "$check_dir/install-$pass"
  else
    grep -q '^已有 .env，跳过向导。$' "$check_dir/install-$pass"
    if grep -q '^向导完成。$' "$check_dir/install-$pass"; then echo '重跑不应执行向导。' >&2; exit 1; fi
  fi
  code=$(curl -k -sS --resolve agent.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://agent.localhost/ready)
  [ "$code" = 200 ] || { echo 'HTTPS /ready 未返回 200。' >&2; exit 1; }
  docker compose cp edge:/data/caddy/pki/authorities/local/root.crt "$check_dir/root.crt"
  printf '%s\n' "$SETUP_ADMIN_PASSWORD" | E2E_BASE_URL=https://agent.localhost NODE_EXTRA_CA_CERTS="$check_dir/root.crt" node scripts/e2e-check.mjs --login-only
  for unit in codex-agent.service codex-agent-backup.timer; do
    [ "$(systemctl is-enabled "$unit")" = enabled ]
  done
  count=$(docker compose exec -T postgres psql -U agent -d agent -Atc 'SELECT count(*) FROM agent_data.users WHERE username IS NOT NULL')
  [ "$count" = 1 ] || { echo '安装后账号数量不是 1。' >&2; exit 1; }
  check_status=0
  docker compose run --rm -T check > "$check_dir/check" || check_status=$?
  [ "$check_status" = 1 ]
  [ "$(grep -c '^✗' "$check_dir/check")" = 1 ]
  grep -q '^✗ AGENT_ALLOWED_ORIGINS' "$check_dir/check"
done
echo '服务器安装验收通过：两次安装、HTTPS 就绪与登录、唯一管理员、开机自启、备份 timer 和容器检查。'
