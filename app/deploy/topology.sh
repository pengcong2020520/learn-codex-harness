#!/usr/bin/env bash
# Source after cd to the application root. Parse dotenv as data, never shell code.
cluster_image=$(sed -n 's/^FROM //p' Dockerfile)
cluster_value=$(docker run --rm --network none -v "$PWD:/app:ro" -w /app \
  -e AGENT_CLUSTER_NODES "$cluster_image" node scripts/cluster-config.mjs nodes) || return 1
read -r -a cluster_nodes <<< "$cluster_value"
[[ ${#cluster_nodes[@]} -gt 0 ]] || { echo '无法读取集群节点配置。' >&2; return 1; }
docker run --rm --network none -v "$PWD:/app:ro" -w /app \
  -e AGENT_CLUSTER_NODES "$cluster_image" node scripts/cluster-config.mjs check || return 1
