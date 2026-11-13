#!/usr/bin/env bash
# 仅一次性容器可越权读取宿主的 0600 配置；只读挂载阻止修改文件。
compose_env_run() {
  docker compose run --rm --no-deps --cap-add DAC_READ_SEARCH \
    -v "$PWD/.env:$PWD/.env:ro" "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  cd "$(dirname "$0")/.."
  compose_env_run "$@"
fi
