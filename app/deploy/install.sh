#!/usr/bin/env bash
# 只部署脚本所在的检出；宿主无需 Node.js，配置解析交给 Compose 和容器向导。
install_script_file=${BASH_SOURCE[0]}

install_usage() {
  cat <<'HELP'
用法：bash deploy/install.sh [选项]
  --cn                     使用阿里云 Docker 源，向导默认使用国内 npm/apt 源
  --registry-mirror <URL>   使用云厂商控制台提供的 Docker Hub 加速地址
  --non-interactive        向导使用环境变量，无需终端输入
  --upgrade                工作区干净时先 git pull --ff-only，再部署当前检出
  --install-docker-only    只安装 Docker 与 Compose，不启动 dockerd（供容器验收）
  -h, --help               显示帮助
支持 root 下的 Ubuntu 22.04/24.04、Debian 12，amd64/arm64。
HELP
}

install_fail() { printf '%s\n' "$1" >&2; exit 1; }
install_step() { install_current_step=$1; printf '\n第 %s 步：%s\n' "$1" "$2"; }
install_step_failed() {
  printf '第 %s 步失败（退出码 %s），已停止；请核对该步骤结果后再决定后续操作。\n' "$install_current_step" "$1" >&2
  exit "$1"
}

# 参数只决定预先列举的发行版和套件，不把系统描述拼入 apt 源。
install_detect_system() {
  local ID='' VERSION_ID=''
  [ -f "$1" ] || { echo '无法读取系统版本，请手动准备 Docker Compose 后按 README 部署。' >&2; return 1; }
  source "$1"
  case "$ID:$VERSION_ID" in
    ubuntu:22.04) install_os=ubuntu; install_suite=jammy ;;
    ubuntu:24.04) install_os=ubuntu; install_suite=noble ;;
    debian:12) install_os=debian; install_suite=bookworm ;;
    *) echo '系统不支持：请使用 Ubuntu 22.04/24.04 或 Debian 12；其他系统请手动准备 Docker Compose 后按 README 部署。' >&2; return 1 ;;
  esac
  case "$2" in
    amd64|arm64) install_arch=$2 ;;
    *) echo '架构不支持：需要 amd64 或 arm64；请手动准备 Docker Compose 后按 README 部署。' >&2; return 1 ;;
  esac
}

install_packages() {
  local package state missing=()
  for package in "$@"; do
    state=$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) || state=''
    [ "$state" = 'install ok installed' ] || missing+=("$package")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    apt-get update
    apt-get install -y "${missing[@]}"
  fi
}

install_docker() {
  if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo 'Docker 与 Compose 已可用，跳过安装。'
    return
  fi
  # 全新系统容器也需要下载密钥的工具；仅安装模式不执行其他部署步骤。
  install_packages ca-certificates curl
  local base=https://download.docker.com/linux
  [ "$install_cn" = 0 ] || base=https://mirrors.aliyun.com/docker-ce/linux
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "$base/$install_os/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: $base/$install_os
Suites: $install_suite
Components: stable
Architectures: $install_arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if [ "$install_only" = 0 ]; then
    systemctl enable --now docker
    docker info >/dev/null
  fi
  docker --version
  docker compose version
  echo 'Docker 与 Compose 安装完成。'
}

install_validate_mirror() {
  # 限制为无认证信息的地址；允许直接写 JSON，也避免在提示中回显凭据。
  [[ "$1" =~ ^https?://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[0-9]+)?(/[a-zA-Z0-9._~/-]*)?$ ]]
}

install_registry_mirror() {
  local file=$1
  if [ -e "$file" ] || [ -L "$file" ]; then
    echo '已有 Docker daemon.json，未修改；请手动合并以下内容后重启 Docker：'
    printf '{"registry-mirrors":["%s"]}\n' "$install_mirror"
  else
    mkdir -p "$(dirname "$file")"
    (umask 022; set -C; printf '{"registry-mirrors":["%s"]}\n' "$install_mirror" > "$file")
    systemctl restart docker
    echo 'Docker Hub 加速地址已配置，Docker 已重启。'
  fi
}

install_setup() {
  if [ -f .env ]; then
    echo '已有 .env，跳过向导。'
    return
  fi
  local name setup_env=() setup_args=()
  # 只传变量名；密码和 Key 不进入命令行参数，也不回显。
  for name in SETUP_ADMIN_PASSWORD SETUP_ADMIN_USER SETUP_DOMAIN SETUP_CN_MIRROR CODEX_MODEL \
    ARK_API_KEY KIMI_API_KEY DEEPSEEK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY \
    XAI_API_KEY ZHIPU_API_KEY HUGGINGFACE_API_KEY; do
    setup_env+=(-e "$name")
  done
  if [ "$install_noninteractive" = 1 ]; then
    setup_args+=(--non-interactive)
    docker compose run --rm -T "${setup_env[@]}" setup "${setup_args[@]}" < /dev/null
  else
    docker compose run --rm "${setup_env[@]}" setup < /dev/tty
  fi
  echo '向导完成。'
}

install_main() {
  set -eEuo pipefail
  install_current_step=预检
  trap 'install_step_failed "$?"' ERR
  install_cn=0 install_only=0 install_noninteractive=0 install_upgrade=0 install_mirror=''
  local next_args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --cn) install_cn=1; next_args+=("$1"); shift ;;
      --non-interactive) install_noninteractive=1; next_args+=("$1"); shift ;;
      --install-docker-only) install_only=1; next_args+=("$1"); shift ;;
      --upgrade) install_upgrade=1; shift ;;
      --registry-mirror)
        [ "$#" -ge 2 ] && install_validate_mirror "$2" || install_fail '镜像加速地址无效：请提供不含账号、口令、查询参数的 HTTP(S) 地址。'
        install_mirror=$2; next_args+=("$1" "$2"); shift 2 ;;
      -h|--help) install_usage; return ;;
      *) install_fail '未知参数，请运行 bash deploy/install.sh --help。' ;;
    esac
  done
  [ "$(id -u)" = 0 ] || install_fail '请用 root 或 sudo bash deploy/install.sh 运行。'
  [ "$(uname -s)" = Linux ] || install_fail '仅支持 Linux 服务器；请手动准备 Docker Compose 后按 README 部署。'
  install_detect_system /etc/os-release "$(dpkg --print-architecture)"
  if [ "$install_only" = 1 ]; then
    [ "$install_upgrade" = 0 ] && [ -z "$install_mirror" ] || install_fail '仅安装 Docker 时不能同时升级代码或配置镜像加速。'
    install_step 3 '安装 Docker 与 Compose（不启动 dockerd）'
    install_docker
    return
  fi
  cd "$(dirname "$install_script_file")/.."
  # 与远程部署相同的路径限制，供 systemd 模板和固定路径挂载使用。
  [[ "$PWD" =~ ^/[a-zA-Z0-9_/-]+$ && "$PWD" != *..* ]] || install_fail '部署目录必须是无空格的英文绝对路径，请在 /opt 下检出仓库。'
  if [ "$install_upgrade" = 1 ]; then
    local changes
    changes=$(git status --porcelain) || install_fail '无法检查 Git 工作区；请在完整检出中升级。'
    [ -z "$changes" ] || install_fail '工作区有本地改动，拒绝升级；请先核对并处理改动。'
    git pull --ff-only --quiet 2>/dev/null || install_fail '快进更新失败，已停止；请手动核对分支、远程与网络。'
    # 更新后重新加载脚本，避免用更新前的函数部署更新后的代码。
    exec bash deploy/install.sh "${next_args[@]}"
  fi
  install_step 1 '预检服务器'
  local memory disk
  memory=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  disk=$(df -Pk . | awk 'NR==2 {print $4}')
  printf '系统：%s %s；架构：%s；内存：%s KiB；可用磁盘：%s KiB。\n' "$install_os" "$install_suite" "$install_arch" "$memory" "$disk"
  [ "$memory" -ge 2097152 ] || echo '警告：内存低于 2 GB，可以手动增加 swap；安装器不会自动添加。'
  [ "$disk" -ge 10485760 ] || echo '警告：可用磁盘低于 10 GB，请注意镜像和备份占用。'
  echo '预检完成。'
  install_step 2 '补齐基础工具'
  install_packages ca-certificates curl gnupg util-linux tar gzip
  echo '基础工具已就绪。'
  install_step 3 '准备 Docker 与 Compose'
  install_docker
  install_step 4 '配置 Docker Hub 镜像加速'
  if [ -n "$install_mirror" ]; then install_registry_mirror /etc/docker/daemon.json; else echo '未指定镜像加速，保留现有配置。'; fi
  install_step 5 '运行配置向导'
  if [ "$install_cn" = 1 ]; then export SETUP_CN_MIRROR=1; fi
  install_setup
  install_step 6 '检查防火墙'
  local enabled_services https=0 ufw_status
  enabled_services=$(docker compose config --services)
  if printf '%s\n' "$enabled_services" | grep -qx edge; then
    https=1
    if command -v ufw >/dev/null 2>&1; then
      ufw_status=$(LC_ALL=C ufw status)
      if printf '%s\n' "$ufw_status" | grep -qx 'Status: active'; then
        ufw allow 80/tcp
        ufw allow 443/tcp
      fi
    fi
    echo '云服务器的安全组也要放行 80 和 443。'
  fi
  echo '防火墙步骤完成。'
  install_step 7 '构建并启动服务'
  docker compose up -d --build --wait
  echo '服务已就绪。'
  install_step 8 '启用开机自启与每日备份'
  bash deploy/enable-service.sh
  bash deploy/enable-backup-timer.sh
  echo '开机自启与备份 timer 已启用。'
  install_step 9 '生产检查与下一步'
  local check_status=0 check_output check_count domain
  # 在子 shell 内处理检查退出码，避免继承的 ERR trap 把正常检查结论报成安装失败。
  check_output=$(docker compose run --rm -T check 2>&1 || exit "$?") || check_status=$?
  printf '%s\n' "$check_output"
  case "$check_status" in
    0|1) ;;
    *) install_step_failed "$check_status" ;;
  esac
  check_count=$(printf '%s\n' "$check_output" | grep -c '^✗' || true)
  if [ "$check_count" -gt 0 ]; then
    printf '部署已完成；生产检查有 %s 项需要在正式上线前处理（见上方 ✗），处理后运行 docker compose run --rm check 复查\n' "$check_count"
  else
    echo '生产静态检查通过；DNS、证书和真实对话仍需确认。'
  fi
  if [ "$https" = 1 ]; then
    domain=$(docker compose exec -T edge printenv AGENT_DOMAIN)
    [[ "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || install_fail '域名格式无效，请核对向导配置。'
    printf '入口：https://%s\n' "$domain"
  else
    echo '服务只监听服务器本机。请在本机保持 SSH 隧道：'
    echo 'ssh -L 4317:127.0.0.1:4317 root@<服务器地址>'
    echo '再打开 http://127.0.0.1:4317/'
  fi
  docker compose run --rm -T check node scripts/setup-summary.mjs --root /project
  echo '备份：每天服务器本地时间 04:00，保存在当前 app 目录的 backups/<节点>/<UTC时间>/。'
  echo '下一步（在当前 app 目录执行）：'
  echo '升级：bash deploy/install.sh --upgrade'
  echo '状态：docker compose ps'
  echo '日志：docker compose logs -f'
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then install_main "$@"; fi
