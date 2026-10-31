#!/usr/bin/env bash
# 部署前检查，在服务器上运行（remote.sh check / deploy 会通过 SSH 执行它）。
# 缺什么就直接说缺什么、怎么装，不在部署到一半时才失败。
fail=0
ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n    → %s\n' "$1" "$2"; fail=1; }

command -v systemctl >/dev/null 2>&1 && ok "systemd" || bad "没有 systemd" "需要使用 systemd 的 Linux 发行版（服务靠它常驻、开机自启）"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)"
  else bad "Docker 守护进程没有运行" "systemctl enable --now docker"; fi
  if docker compose version >/dev/null 2>&1; then ok "$(docker compose version)"
  else bad "缺少 docker compose v2" "安装 docker-compose-plugin：https://docs.docker.com/compose/install/linux/"; fi
else bad "没有 Docker" "安装 Docker Engine：https://docs.docker.com/engine/install/"; fi
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -ge 24 ]; then ok "Node.js $(node -v)"
else bad "需要 Node.js 24+（当前：$(node -v 2>/dev/null || echo 未安装)）" "https://nodejs.org/en/download；RHEL 系：curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - && dnf install -y nodejs；Debian / Ubuntu：curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs"; fi
command -v rsync >/dev/null 2>&1 && ok "rsync" || bad "没有 rsync" "dnf install -y rsync 或 apt-get install -y rsync"
avail=$(df --output=avail -BG / 2>/dev/null | tail -1 | tr -dc 0-9)
if [ "${avail:-0}" -ge 3 ]; then ok "磁盘剩余 ${avail} GB"; else bad "磁盘剩余 ${avail:-?} GB" "至少需要 3 GB（数据库镜像与依赖约 1.5 GB）"; fi
mem=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')
[ -n "$mem" ] || mem=$(awk '/^MemAvailable:/{print int($2 / 1024)}' /proc/meminfo 2>/dev/null)
if [ -z "$mem" ]; then :
elif [ "$mem" -ge 600 ]; then ok "可用内存 ${mem} MB"; else bad "可用内存 ${mem} MB" "服务运行约需 400–600 MB；先停掉不用的服务"; fi
# 端口被本服务自己占着（重复部署）不算冲突：进程属于 codex-harness*.service 单元，或是本项目 compose 容器发布的端口。
# 不按进程名判断：Node 24 的主线程名是 MainThread，换个启动方式名字也会变。
ours() {
  case "$(ps -o unit= -p "$1" 2>/dev/null)" in codex-harness*.service) return 0 ;; esac
  docker ps --filter label=com.docker.compose.project=codex-harness-app --format '{{.Ports}}' 2>/dev/null | grep -q ":$2->"
}
if command -v ss >/dev/null 2>&1; then
  for port in 4317 14320 5432 6379; do
    line=$(ss -ltnpH "sport = :$port" 2>/dev/null | head -1)
    [ -n "$line" ] || continue
    pid=$(printf '%s' "$line" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && ours "$pid" "$port" && continue
    name=$(printf '%s' "$line" | grep -o 'users:(("[^"]*' | cut -d'"' -f2)
    bad "端口 $port 被 ${name:-其他进程}${pid:+（PID ${pid}）}占用" "停掉占用的服务，或修改 compose.yaml 端口 / AGENT_PORT / 工作台单元的 WORKBENCH_PORT"
  done
fi
[ "$fail" -eq 0 ] && echo "  服务器满足部署条件。"
exit "$fail"
