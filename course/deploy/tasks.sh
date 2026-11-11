# 由 server-setup.sh 在 course/ 内加载。一次性容器不加入 web 网络，web 停止时也可运行。
in_stages() {
  docker compose -f compose.yaml -f deploy/tasks.compose.yaml run --rm --no-deps -T tasks "$@"
}
gateway_config() {
  in_stages node /opt/stages-deploy/gateway-config.mjs
  in_stages node /opt/stages-deploy/stages-config.mjs
}
s11_script() {
  in_stages sh -c 'script=$1; shift; exec node "$CONTAINER_STAGES_DIR/s11-model-gateway/scripts/$script" "$@"' sh "$@"
}
