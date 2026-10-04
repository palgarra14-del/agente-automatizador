#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ollama-local.service.d"
DROP_IN="$UNIT_DIR/resource-guard.conf"

mkdir -p "$UNIT_DIR"
cat > "$DROP_IN" <<'EOF'
[Service]
Environment=OLLAMA_KEEP_ALIVE=30s
MemoryHigh=4G
MemoryMax=5G
MemorySwapMax=768M
OOMPolicy=stop
Restart=always
RestartSec=15s
EOF

systemctl --user daemon-reload
systemctl --user reset-failed ollama-local.service 2>/dev/null || true
systemctl --user try-restart ollama-local.service

echo "Installed $DROP_IN"
systemctl --user show ollama-local.service \
  -p ActiveState -p SubState -p MemoryHigh -p MemoryMax -p MemorySwapMax -p OOMPolicy --no-pager
