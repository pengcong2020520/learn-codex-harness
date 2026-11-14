#!/bin/sh
set -eu
[ -n "${AGENT_DOMAIN:-}" ] || { echo '请设置 AGENT_DOMAIN 后再启用 https profile。' >&2; exit 1; }
# 仅允许测试用内部 CA；不把任意环境变量文本作为 Caddy 指令执行。
case "${AGENT_TLS:-}" in
  '') AGENT_TLS_DIRECTIVE='' ;;
  internal) AGENT_TLS_DIRECTIVE='tls internal' ;;
  *) echo 'AGENT_TLS 只支持空值（公网证书）或 internal（仅测试）。' >&2; exit 1 ;;
esac
export AGENT_TLS_DIRECTIVE
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
