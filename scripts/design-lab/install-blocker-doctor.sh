#!/usr/bin/env bash
set -euo pipefail

REPO="${AGENT_REPO:-/home/pablo/projects/agente-automatizador}"
STATE="${DESIGN_LAB_STATE_DIR:-/home/pablo/.local/state/engineering-orchestrator/design-lab}"
UNIT_DIR="/home/pablo/.config/systemd/user"
DOCTOR_SERVICE="$UNIT_DIR/engineering-orchestrator-design-lab-doctor.service"
LAB_DROPIN_DIR="$UNIT_DIR/engineering-orchestrator-design-lab.service.d"
DOCTOR_DROPIN="$LAB_DROPIN_DIR/doctor.conf"

test -x "$REPO/scripts/design-lab/blocker-doctor.py"
mkdir -p "$UNIT_DIR" "$LAB_DROPIN_DIR" "$STATE"

cat > "$DOCTOR_SERVICE" <<EOF
[Unit]
Description=Intelligent blocker diagnosis and safe recovery for website design lab
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=/home/pablo
Environment=AGENT_REPO=$REPO
Environment=DESIGN_LAB_STATE_DIR=$STATE
Environment=PATH=/home/pablo/.nvm/versions/node/v22.23.2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$REPO/scripts/design-lab/blocker-doctor.py
TimeoutStartSec=4min
Nice=8
UMask=0077
EOF

cat > "$DOCTOR_DROPIN" <<EOF
[Unit]
OnFailure=engineering-orchestrator-design-lab-doctor.service
EOF

systemctl --user daemon-reload
systemctl --user reset-failed engineering-orchestrator-design-lab-doctor.service >/dev/null 2>&1 || true
echo "blocker_doctor_installed=true"
