#!/usr/bin/env bash
# Install dsh-remote-agent on Linux as a systemd USER service.
#
# Usage:
#   ./install-linux.sh [port]        # port defaults to 5188
#   DSH_RC_TOKEN=xxx ./install-linux.sh 5200
#
# The agent is copied to ~/.dsh-remote-agent and enabled with:
#   systemctl --user enable --now dsh-remote-agent
# If systemd is unavailable, a nohup fallback is started instead.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-5188}"
INSTALL_DIR="$HOME/.dsh-remote-agent"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node 18+ first." >&2
  exit 1
fi

echo "[1/3] Installing agent files to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
cp -f "$DIR/dsh-remote-agent.mjs" "$INSTALL_DIR/dsh-remote-agent.mjs"
cp -f "$DIR/run-linux.sh" "$INSTALL_DIR/run-linux.sh"
chmod +x "$INSTALL_DIR/run-linux.sh"

# Optional token via environment: stored in a 0600 env file for systemd.
if [ -n "${DSH_RC_TOKEN:-}" ]; then
  umask 077
  printf 'DSH_RC_TOKEN=%s\n' "$DSH_RC_TOKEN" > "$INSTALL_DIR/agent.env"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user show >/dev/null 2>&1; then
  echo "[2/3] Installing systemd user service (port $PORT) ..."
  mkdir -p "$HOME/.config/systemd/user"
  UNIT="$HOME/.config/systemd/user/dsh-remote-agent.service"
  cat > "$UNIT" <<EOF
[Unit]
Description=DSH Remote Agent (DeepSeek Harness remote control)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v env) node $INSTALL_DIR/dsh-remote-agent.mjs --host 0.0.0.0 --port $PORT
Restart=on-failure
RestartSec=3
EOF
  if [ -f "$INSTALL_DIR/agent.env" ]; then
    printf 'EnvironmentFile=%s/agent.env\n' "$INSTALL_DIR" >> "$UNIT"
  fi
  cat >> "$UNIT" <<'EOF'

[Install]
WantedBy=default.target
EOF
  echo "[3/3] Enabling and starting service ..."
  systemctl --user daemon-reload
  systemctl --user enable --now dsh-remote-agent
  echo "Done. Check status with: systemctl --user status dsh-remote-agent"
else
  echo "[2/3] systemd unavailable, using nohup fallback (port $PORT) ..."
  cd "$INSTALL_DIR"
  nohup node "$INSTALL_DIR/dsh-remote-agent.mjs" --host 0.0.0.0 --port "$PORT" \
    > "$INSTALL_DIR/agent.log" 2>&1 &
  echo $! > "$INSTALL_DIR/agent.pid"
  echo "[3/3] Started with pid $(cat "$INSTALL_DIR/agent.pid"). Log: $INSTALL_DIR/agent.log"
  echo "Note: this fallback does NOT survive reboot."
fi

if [ ! -f "$INSTALL_DIR/agent-token.txt" ]; then
  echo "No token supplied. The agent generates one on first start and writes it to:"
  echo "  $INSTALL_DIR/agent-token.txt"
else
  echo "Token file: $INSTALL_DIR/agent-token.txt"
fi
echo "Use that token when adding this machine in the harness plugin (remote_machine_add)."
