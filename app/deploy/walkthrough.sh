#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$#" -lt 1 || "$#" -gt 2 || "${1:-}" == "--help" ]]; then
  echo '用法：bash deploy/walkthrough.sh design/<产品 id>/walkthrough/<确认的计划.json> [上轮导出的反馈.json]'
  [[ "${1:-}" == "--help" ]] && exit 0 || exit 1
fi
[[ -f "$1" ]] || { echo '找不到巡查计划。' >&2; exit 1; }
export WALKTHROUGH_DIR
WALKTHROUGH_DIR=$(cd "$(dirname "$1")" && pwd -P)
case "$WALKTHROUGH_DIR" in "$(pwd -P)"/design/*/walkthrough) ;; *) echo '请将计划放在 design/<产品 id>/walkthrough/。' >&2; exit 1;; esac
args=(compose run --rm --no-deps --build --user "$(id -u):$(id -g)")
# 仅传递专用于本轮测试的输入，值不会出现在命令行或巡查记录。
while IFS= read -r name; do
  [[ "$name" == WALKTHROUGH_INPUT_* ]] && args+=(-e "$name")
done < <(compgen -e)
files=("/review/$(basename "$1")")
if [[ "$#" -eq 2 ]]; then
  [[ -f "$2" ]] || { echo '找不到上轮反馈 JSON。' >&2; exit 1; }
  previous=$(cd "$(dirname "$2")" && pwd -P)
  args+=(-v "$previous/$(basename "$2"):/previous.json:ro")
  files+=(/previous.json)
fi
docker compose exec -T caddy wget -q -O /dev/null http://127.0.0.1/ready || { echo '本机产品尚未就绪，请先核对 docker compose ps 与 /ready。' >&2; exit 1; }
docker "${args[@]}" walkthrough "${files[@]}"
echo "本机走查记录：$WALKTHROUGH_DIR"
