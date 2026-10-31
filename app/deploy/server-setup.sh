#!/usr/bin/env bash
# 在服务器上以 root 运行（由 remote.sh deploy 调用），可以重复执行：
# 建运行用户 → 安装 systemd 单元 → 安装依赖 → 建工作区目录 → 启动数据服务 → 迁移 → 重启常驻服务 → 等健康检查通过。
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/learn-codex-harness/app}
RUN_USER=codex
RUN_HOME=/var/lib/$RUN_USER
cd "$APP_DIR"
test -f .env || { echo "缺少 $APP_DIR/.env，先在本机运行 remote.sh init-env。" >&2; exit 1; }

as_user() { runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" "$@"; }

id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$RUN_HOME" --shell /sbin/nologin "$RUN_USER"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
chmod 600 .env
install -m 644 deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q codex-harness-db.service codex-harness.service codex-harness-web.service

echo "== 安装依赖"
as_user npm ci --no-audit --no-fund --loglevel=error
echo "== 准备工作区目录（只建 Agent 定义里声明的目录，不覆盖已有文件）"
as_user npm run -s agent:init
echo "== 启动数据服务并迁移"
systemctl start codex-harness-db.service
as_user npm run -s data:migrate
echo "== 重启常驻服务"
systemctl reset-failed codex-harness.service codex-harness-web.service 2>/dev/null || true
systemctl restart codex-harness.service codex-harness-web.service

# 服务启动后会写出新的 .data/connection.json；用里面的令牌请求 /health。
health() {
  as_user node -e '
    const { url, token } = JSON.parse(require("fs").readFileSync(".data/connection.json", "utf8"));
    fetch(url + "/health", { headers: { authorization: "Bearer " + token } })
      .then(r => r.json()).then(v => { console.log(v.status); process.exit(v.status === "ready" ? 0 : 1); })
      .catch(() => process.exit(1));' 2>/dev/null
}
for _ in $(seq 1 60); do
  if systemctl is-active -q codex-harness.service && health >/dev/null; then
    echo "== 就绪：$(cat REVISION 2>/dev/null || echo 未知版本)"
    systemctl --no-pager is-active codex-harness-db.service codex-harness.service codex-harness-web.service | paste -sd' ' -
    exit 0
  fi
  sleep 2
done
echo "服务没有在 120 秒内就绪，最近日志：" >&2
journalctl -u codex-harness.service -n 30 --no-pager >&2
exit 1
