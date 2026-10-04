#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/engineering-orchestrator-cloud-heartbeat.timer.d"
DROP_IN="$UNIT_DIR/resilient-calendar.conf"

mkdir -p "$UNIT_DIR"
cat > "$DROP_IN" <<'EOF'
[Timer]
OnUnitActiveSec=
OnCalendar=*-*-* *:0/2:00
RandomizedDelaySec=5s
AccuracySec=5s
Persistent=true
EOF

systemctl --user daemon-reload
systemctl --user reset-failed engineering-orchestrator-cloud-heartbeat.service 2>/dev/null || true
systemctl --user restart engineering-orchestrator-cloud-heartbeat.timer

echo "Installed $DROP_IN"
systemctl --user show engineering-orchestrator-cloud-heartbeat.timer \
  -p ActiveState -p SubState -p NextElapseUSecRealtime -p LastTriggerUSec --no-pager
