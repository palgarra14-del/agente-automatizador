#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="${AGENT_ROOT:-$HOME/projects/agente-automatizador}"
[[ -d "$AGENT_ROOT/.git" || -f "$AGENT_ROOT/.git" ]] || { echo "No encuentro el agente en $AGENT_ROOT"; exit 1; }
BIN="$HOME/.local/bin/cloudflared"
UNITS="$HOME/.config/systemd/user"
mkdir -p "$HOME/.local/bin" "$UNITS" "$HOME/.config/agent-control-center"

if [[ ! -x "$BIN" ]]; then
  arch="$(uname -m)"
  [[ "$arch" == "x86_64" ]] || { echo "Arquitectura no soportada automáticamente: $arch"; exit 1; }
  curl -fL --retry 3 --connect-timeout 15     https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64     -o "$BIN"
  chmod 700 "$BIN"
fi

cat > "$UNITS/agent-control-center.service" <<EOF
[Unit]
Description=Agent mobile control center
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=AGENT_ROOT=$AGENT_ROOT
ExecStart=$(command -v node) $ROOT/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

cat > "$UNITS/agent-control-tunnel.service" <<EOF
[Unit]
Description=Agent mobile control public tunnel
After=network-online.target agent-control-center.service
Requires=agent-control-center.service

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$(command -v node) $ROOT/tunnel.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable agent-control-center.service agent-control-tunnel.service
systemctl --user restart agent-control-center.service
systemctl --user is-active --quiet agent-control-tunnel.service || systemctl --user start agent-control-tunnel.service

for _ in {1..30}; do
  [[ -s "$HOME/.config/agent-control-center/access-token" && -s "$HOME/.config/agent-control-center/tunnel-url" ]] && break
  sleep 1
done

echo "Control center activo."
[[ -s "$HOME/.config/agent-control-center/access-token" ]] && echo "Clave: $(<"$HOME/.config/agent-control-center/access-token")"
[[ -s "$HOME/.config/agent-control-center/tunnel-url" ]] && echo "URL: $(<"$HOME/.config/agent-control-center/tunnel-url")"
