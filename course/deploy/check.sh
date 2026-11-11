#!/usr/bin/env bash
# 部署前检查，在服务器上运行（remote.sh check / deploy 会通过 SSH 执行它）。
# 缺什么就直接说缺什么、怎么装，不在部署到一半时才失败。
fail=0
ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n    → %s\n' "$1" "$2"; fail=1; }
warn() { printf '  ! %s\n    → %s\n' "$1" "$2"; }

command -v systemctl >/dev/null 2>&1 && ok "systemd" || bad "没有 systemd" "需要使用 systemd 的 Linux 发行版（服务靠它常驻、开机自启）"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)"
  else bad "Docker 守护进程没有运行" "systemctl enable --now docker"; fi
  if docker compose version >/dev/null 2>&1; then ok "$(docker compose version)"
  else bad "缺少 docker compose v2" "安装 docker-compose-plugin：https://docs.docker.com/compose/install/linux/"; fi
else bad "没有 Docker" "安装 Docker Engine：https://docs.docker.com/engine/install/（国内服务器可用云厂商的 Docker 软件源，并在 /etc/docker/daemon.json 配置 registry-mirrors 加速拉取镜像）"; fi
# 全部服务都在容器里（智能体与工作台用镜像里的 Node），宿主不需要装 Node。
command -v rsync >/dev/null 2>&1 && ok "rsync" || bad "没有 rsync" "dnf install -y rsync 或 apt-get install -y rsync"
# 九阶段依赖与镜像约 3–5 GB。剩余磁盘不足 8 GB 则不能部署。
disk_need=8
avail=$(df --output=avail -BG / 2>/dev/null | tail -1 | tr -dc 0-9)
if [ "${avail:-0}" -ge "$disk_need" ]; then ok "磁盘剩余 ${avail} GB"
else bad "磁盘剩余 ${avail:-?} GB" "至少需要 ${disk_need} GB（九阶段依赖与镜像约 3–5 GB；构建缓存与持久数据需额外空间）"; fi
# 硬性要求是可用内存 + 空闲 swap ≥ 2048 MB（九阶段空闲约 1.5–2 GB）。
# 可用内存低于 3000 MB 只警告：Ollama 加载向量模型约 1.1 GB，不因此拒绝部署。
mem=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')
swap=$(free -m 2>/dev/null | awk '/^Swap:/{print $4}')
if [ -z "$mem" ]; then
  mem=$(awk '/^MemAvailable:/{print int($2 / 1024)}' /proc/meminfo 2>/dev/null)
  swap=$(awk '/^SwapFree:/{print int($2 / 1024)}' /proc/meminfo 2>/dev/null)
fi
if [ -n "$mem" ]; then
  swap=${swap:-0}
  if [ $((mem + swap)) -ge 2048 ]; then
    if [ "$mem" -lt 3000 ]; then
      warn "可用内存 ${mem} MB（空闲 swap ${swap} MB）" "Ollama 加载向量模型约需 1.1 GB。内存紧张时建议不用 RAG，或给 stages 设更低的 mem_limit（STAGES_MEMORY_LIMIT，默认 1800m）"
    else ok "可用内存 ${mem} MB"; fi
  else bad "可用内存 ${mem} MB + 空闲 swap ${swap} MB" "至少需要合计 2048 MB（九阶段空闲约 1.5–2 GB）。先停掉不用的服务、加 swap，或加内存"; fi
fi
# 端口被本服务自己占着（重复部署）不算冲突：进程属于 codex-harness*.service 单元，或是本项目 compose 容器发布的端口。
# 不按进程名判断：Node 24 的主线程名是 MainThread，换个启动方式名字也会变。
ours() {
  case "$(ps -o unit= -p "$1" 2>/dev/null)" in codex-harness*.service) return 0 ;; esac
  docker ps --filter label=com.docker.compose.project=codex-harness-app --format '{{.Ports}}' 2>/dev/null | grep -q ":$2->"
}
if command -v ss >/dev/null 2>&1; then
  for port in 14320 5432 6379 4330; do
    line=$(ss -ltnpH "sport = :$port" 2>/dev/null | head -1)
    [ -n "$line" ] || continue
    pid=$(printf '%s' "$line" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && ours "$pid" "$port" && continue
    name=$(printf '%s' "$line" | grep -o 'users:(("[^"]*' | cut -d'"' -f2)
    bad "端口 $port 被 ${name:-其他进程}${pid:+（PID ${pid}）}占用" "停掉占用的服务，或修改 compose.yaml 端口 / AGENT_GATEWAY_PORT / 工作台单元的 WORKBENCH_PORT"
  done
fi
[ "$fail" -eq 0 ] && echo "  服务器满足部署条件。"
exit "$fail"
