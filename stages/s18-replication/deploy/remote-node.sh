#!/usr/bin/env bash
# Run on the SECOND Linux server after copying code, .remote.env and deployment identity.
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/s18-replication}
NODE_ID=${NODE_ID:-node-b}
CONTROL_HOST=${CONTROL_HOST:-control.example.com}
SSH_KEY=${SSH_KEY:-/var/lib/codex-tunnel/.ssh/s18-tunnel}
SSH_USER=${SSH_USER:-codex-tunnel}
# Pure output mode lets the administrator provision the restricted account before installation.
if [[ $SSH_USER == root ]]; then echo '隧道必须使用专用非 root 系统账号。' >&2; exit 1; fi
print_authorized_key() {
  local public_key options
  public_key=$(ssh-keygen -y -f "$SSH_KEY")
  options='restrict,port-forwarding,permitopen="127.0.0.1:12379",permitopen="127.0.0.1:15432",permitopen="127.0.0.1:16379",permitopen="127.0.0.1:18080"'
  for port in 4340 4341 4342; do
    if [[ $port != "$default_port" ]]; then options+=",permitopen=\"127.0.0.1:$((port+10000))\""; fi
  done
  printf '%s,permitlisten="127.0.0.1:%s",command="/bin/false" %s\n' "$options" "$REVERSE_PORT" "$public_key"
}
case $NODE_ID in node-a) default_port=4340;; node-b) default_port=4341;; node-c) default_port=4342;; *) exit 1;; esac
NODE_PORT=${NODE_PORT:-$default_port}
REVERSE_PORT=${REVERSE_PORT:-$((default_port+10000))}
if [[ ${1:-} == --authorized-key ]]; then print_authorized_key; exit 0; fi
[[ $EUID -eq 0 ]] || { echo '需要 root 安装 systemd 单元和 uid 目录。' >&2; exit 1; }
[[ $APP_DIR =~ ^/[a-zA-Z0-9_/-]+$ && $APP_DIR != / && $APP_DIR != *..* ]] || exit 1
[[ $NODE_ID =~ ^node-[abc]$ && $CONTROL_HOST =~ ^[a-zA-Z0-9.-]+$ && $SSH_USER =~ ^[a-z_][a-z0-9_-]*$ && $SSH_KEY =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 1
[[ $NODE_PORT =~ ^[0-9]+$ && $REVERSE_PORT =~ ^[0-9]+$ ]] || exit 1
print_authorized_key
if ! id codex-tunnel >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/codex-tunnel --shell /usr/sbin/nologin codex-tunnel
fi
chown codex-tunnel:codex-tunnel "$SSH_KEY"
chmod 600 "$SSH_KEY"
cd "$APP_DIR"
test -f .remote.env && test -f .remote-identity.json && test -f "$SSH_KEY"
# Never source dotenv as shell code; verify role against the strictly scoped environment.
grep -qx "AGENT_NODE_ID=$NODE_ID" .remote.env
grep -qx "AGENT_PORT=$NODE_PORT" .remote.env
node_forwards=""
for port in 4340 4341 4342; do
  if [ "$port" != "$default_port" ]; then node_forwards+=" -L 127.0.0.1:$port:127.0.0.1:$((port+10000))"; fi
done
mkdir -p "nodes/$NODE_ID/.data/gateway" "nodes/$NODE_ID/.runs" "nodes/$NODE_ID/workspace" "backups/$NODE_ID"
if [ -f "nodes/$NODE_ID/.data/identity.json" ]; then
  cmp .remote-identity.json "nodes/$NODE_ID/.data/identity.json"
else
  cp .remote-identity.json "nodes/$NODE_ID/.data/identity.json"
fi
chmod 600 .remote.env "nodes/$NODE_ID/.data/identity.json"
chown -R 0:1000 "nodes/$NODE_ID/.data/gateway"
# StrictHostKeyChecking requires prior out-of-band host-key verification. No private key enters the node container.
cat > /etc/systemd/system/codex-harness-s18-tunnel.service <<UNIT
[Unit]
Description=s18 remote node SSH tunnel
After=network-online.target
Wants=network-online.target
[Service]
User=codex-tunnel
Group=codex-tunnel
ExecStart=/usr/bin/ssh -NT -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -L 127.0.0.1:12379:127.0.0.1:12379 -L 127.0.0.1:15432:127.0.0.1:15432 -L 127.0.0.1:16379:127.0.0.1:16379 -L 127.0.0.1:18080:127.0.0.1:18080 $node_forwards -R 127.0.0.1:$REVERSE_PORT:127.0.0.1:$NODE_PORT $SSH_USER@$CONTROL_HOST
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/codex-harness-s18-remote.service <<UNIT
[Unit]
Description=s18 single remote node
Requires=docker.service codex-harness-s18-tunnel.service
After=docker.service codex-harness-s18-tunnel.service
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/docker compose --env-file .remote.env -f deploy/remote.compose.yaml up -d --wait
ExecStop=/usr/bin/docker compose --env-file .remote.env -f deploy/remote.compose.yaml stop
TimeoutStartSec=600
[Install]
WantedBy=multi-user.target
UNIT
export APP_DIR
# Build uses code + lockfile only; .remote.env is excluded by .dockerignore.
docker compose --env-file .remote.env -f deploy/remote.compose.yaml build
systemctl daemon-reload
systemctl enable --now codex-harness-s18-tunnel.service codex-harness-s18-remote.service
