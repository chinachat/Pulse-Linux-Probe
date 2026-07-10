#!/usr/bin/env bash
set -eu
DIR=${1:-/opt/pulse-probe}
PORT=${PORT:-8080}
if ! command -v python3 >/dev/null; then
  echo 'Python 3 is required. Install it with your distribution package manager first.' >&2; exit 1
fi
install -d "$DIR"
echo 'Copy server.py, index.html, app.js, style.css and agent.sh into this directory before running this installer.'
test -f "$DIR/server.py" || { echo "server.py not found in $DIR" >&2; exit 1; }
cat > /etc/systemd/system/pulse-probe.service <<EOF
[Unit]
Description=Pulse Linux Probe
After=network.target
[Service]
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=PROBE_ADMIN_PASSWORD=${PROBE_ADMIN_PASSWORD:?Set PROBE_ADMIN_PASSWORD before running}
Environment=PROBE_DATA_KEY=${PROBE_DATA_KEY:?Set PROBE_DATA_KEY before running}
ExecStart=$(command -v python3) $DIR/server.py
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now pulse-probe
echo "Started on port $PORT"
