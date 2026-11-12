#!/bin/sh
set -eu
case "${AGENT_CLUSTER_NODES-node-a}" in
 node-a) AGENT_UPSTREAMS='node-a:4340' ;;
 node-a,node-b) AGENT_UPSTREAMS="node-a:4340 ${NODE_B_UPSTREAM:-node-b:4341}" ;;
 node-a,node-b,node-c) AGENT_UPSTREAMS="node-a:4340 ${NODE_B_UPSTREAM:-node-b:4341} node-c:4342" ;;
 *) echo 'AGENT_CLUSTER_NODES 只能是 node-a、node-a,node-b 或 node-a,node-b,node-c（顺序固定）。' >&2; exit 1 ;;
esac
export AGENT_UPSTREAMS
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
