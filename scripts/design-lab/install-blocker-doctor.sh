#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
REPO="${AGENT_REPO:-$DEFAULT_REPO}"
STATE="${DESIGN_LAB_STATE_DIR:-$HOME/.local/state/engineering-orchestrator/design-lab}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DOCTOR_SERVICE="$UNIT_DIR/engineering-orchestrator-design-lab-doctor.service"
LAB_DROPIN_DIR="$UNIT_DIR/engineering-orchestrator-design-lab.service.d"
DOCTOR_DROPIN="$LAB_DROPIN_DIR/doctor.conf"
RECOVERY_DROPIN="$LAB_DROPIN_DIR/recovery.conf"

test -x "$REPO/scripts/design-lab/blocker-doctor.py"
mkdir -p "$UNIT_DIR" "$LAB_DROPIN_DIR" "$STATE"

cat > "$DOCTOR_SERVICE" <<EOF
[Unit]
Description=Intelligent blocker diagnosis and safe recovery for website design lab
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=$HOME
Environment=AGENT_REPO=$REPO
Environment=DESIGN_LAB_STATE_DIR=$STATE
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$REPO/scripts/design-lab/blocker-doctor.py
TimeoutStartSec=4min
Nice=8
UMask=0077
EOF

cat > "$DOCTOR_DROPIN" <<EOF
[Unit]
OnFailure=engineering-orchestrator-design-lab-doctor.service
EOF

# The design-lab timer runs on an approximately five-minute cadence. Keep
# restart/start-limit policy aligned with that cadence instead of carrying the
# old workstation-specific burst window forward.
cat > "$RECOVERY_DROPIN" <<EOF
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=4

[Service]
Restart=on-failure
RestartSec=90s
EOF

systemctl --user daemon-reload
systemctl --user reset-failed engineering-orchestrator-design-lab-doctor.service >/dev/null 2>&1 || true
systemctl --user reset-failed engineering-orchestrator-design-lab.service >/dev/null 2>&1 || true
echo "blocker_doctor_installed=true"
