#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="$UNIT_DIR/engineering-orchestrator-cloud-heartbeat.service"
TIMER="$UNIT_DIR/engineering-orchestrator-cloud-heartbeat.timer"
NODE="$(command -v node)"
ENABLE=0

if [[ "${1:-}" == "--enable" ]]; then
  ENABLE=1
elif [[ -n "${1:-}" ]]; then
  echo "Uso: $0 [--enable]" >&2
  exit 2
fi

[[ -d "$ROOT/.git" ]] || { echo "No encuentro el agente en $ROOT" >&2; exit 1; }
[[ -x "$NODE" ]] || { echo "Node no disponible" >&2; exit 1; }
[[ "${MODEL_COST_POLICY:-free_only}" =~ ^(free_only|subscription_included)$ ]] || {
  echo "MODEL_COST_POLICY debe ser free_only o subscription_included" >&2
  exit 1
}

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "$XDG_RUNTIME_DIR/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

mkdir -p "$UNIT_DIR"
umask 077

append_env() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]] || return 0
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    echo "$name contiene saltos de línea" >&2
    exit 1
  }
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf 'Environment="%s=%s"\n' "$name" "$value"
}

{
  cat <<EOF
# managed-by=engineering-orchestrator:native-heartbeat:v1
[Unit]
Description=Engineering Orchestrator native cloud heartbeat
After=network-online.target engineering-orchestrator-inbox.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/scripts/cloud-heartbeat.js
Environment="HOME=$HOME"
Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="AGENT_HEARTBEAT_EXECUTION_MODE=local-primary"
Environment="MODEL_COST_POLICY=${MODEL_COST_POLICY:-free_only}"
EOF
  for name in     XDG_CONFIG_HOME GH_CONFIG_DIR GH_HOST CODEX_HOME LANG LC_ALL     ANTIGRAVITY_CLI ANTIGRAVITY_AUTH_TTL CODEX_BIN     OPENCODE_BIN OPENCODE_FREE_TIMEOUT OPENCODE_MODELS_TTL     MODEL_PROVIDER_FAILURE_COOLDOWN_SECONDS MODEL_CANDIDATE_FAILURE_COOLDOWN_SECONDS     MODEL_PROVIDER_SLOT_WAIT_SECONDS MODEL_PROVIDER_MAX_ANTIGRAVITY     MODEL_PROVIDER_MAX_OPENCODE MODEL_PROVIDER_MAX_CODEX
  do
    append_env "$name"
  done
  cat <<'EOF'
UMask=0077
TimeoutStartSec=120
StandardOutput=journal
StandardError=journal
EOF
} > "$SERVICE"

cat > "$TIMER" <<'EOF'
# managed-by=engineering-orchestrator:native-heartbeat:v1
[Unit]
Description=Engineering Orchestrator native heartbeat every 2 minutes

[Timer]
OnCalendar=*-*-* *:0/2:00
RandomizedDelaySec=5s
AccuracySec=5s
Persistent=true
Unit=engineering-orchestrator-cloud-heartbeat.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
if [[ "$ENABLE" == "1" ]]; then
  systemctl --user enable --now engineering-orchestrator-cloud-heartbeat.timer
fi

echo "Heartbeat nativo instalado."
if [[ "$ENABLE" == "1" ]]; then
  echo "Timer habilitado."
else
  echo "Timer no habilitado; usa --enable cuando el estado remoto esté reconciliado."
fi
