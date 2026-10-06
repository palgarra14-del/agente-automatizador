#!/usr/bin/env bash
set -euo pipefail

MODEL="qwen2.5-coder:3b"
ENABLE=0
PULL=0

for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE=1 ;;
    --pull-model) PULL=1 ;;
    --model=*) MODEL="${arg#--model=}" ;;
    *)
      echo "Uso: $0 [--enable] [--pull-model] [--model=nombre]" >&2
      exit 2
      ;;
  esac
done

for command in pacman pacman-key curl bsdtar systemctl; do
  command -v "$command" >/dev/null || { echo "Falta $command" >&2; exit 1; }
done

[[ "$MODEL" =~ ^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]] || {
  echo "Modelo Ollama inválido" >&2
  exit 1
}

URL="$(pacman -Sp --print-format '%n %l' ollama | awk '$1=="ollama" {print $2; exit}')"
[[ "$URL" == http://* || "$URL" == https://* ]] || {
  echo "No se pudo resolver el paquete oficial ollama de Arch" >&2
  exit 1
}

PACKAGE_NAME="$(basename "$URL")"
VERSION="${PACKAGE_NAME#ollama-}"
VERSION="${VERSION%-x86_64.pkg.tar.zst}"
[[ "$VERSION" != "$PACKAGE_NAME" && -n "$VERSION" ]] || {
  echo "Nombre de paquete Ollama inesperado: $PACKAGE_NAME" >&2
  exit 1
}

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/engineering-orchestrator/ollama"
DEST="$HOME/.local/opt/ollama-arch-$VERSION"
BIN="$HOME/.local/bin/ollama"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="$UNIT_DIR/ollama-local.service"
MODELS="$HOME/.local/share/ollama/models"
PKG="$CACHE_DIR/$PACKAGE_NAME"
SIG="$PKG.sig"

mkdir -p "$CACHE_DIR" "$DEST" "$(dirname "$BIN")" "$UNIT_DIR" "$MODELS"
curl -fL --retry 3 --connect-timeout 15 "$URL" -o "$PKG"
curl -fL --retry 3 --connect-timeout 15 "$URL.sig" -o "$SIG"
pacman-key --verify "$SIG" "$PKG"

rm -rf "$DEST"
mkdir -p "$DEST"
bsdtar -xf "$PKG" -C "$DEST" usr/bin/ollama usr/lib/ollama

cat > "$BIN" <<EOF
#!/usr/bin/env sh
set -eu
ROOT="$DEST"
export LD_LIBRARY_PATH="\$ROOT/usr/lib/ollama\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "\$ROOT/usr/bin/ollama" "\$@"
EOF
chmod 700 "$BIN"

cat > "$SERVICE" <<EOF
# managed-by=engineering-orchestrator:rootless-ollama:v1
[Unit]
Description=Ollama local fallback (rootless Arch package)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN serve
Environment="HOME=$HOME"
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MODELS=$MODELS"
Environment="OLLAMA_NO_CLOUD=true"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Restart=always
RestartSec=3
Nice=10
CPUQuota=200%
MemoryHigh=5G
MemoryMax=6G
UMask=0077

[Install]
WantedBy=default.target
EOF

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "$XDG_RUNTIME_DIR/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

systemctl --user daemon-reload
if [[ "$ENABLE" == "1" ]]; then
  systemctl --user enable ollama-local.service
  systemctl --user restart ollama-local.service
  ready=0
  for _ in {1..30}; do
    if "$BIN" list >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.2
  done
  [[ "$ready" == "1" ]] || {
    echo "Ollama no superó el healthcheck local" >&2
    exit 1
  }
fi

if [[ "$PULL" == "1" ]]; then
  [[ "$ENABLE" == "1" ]] || {
    echo "--pull-model requiere --enable para garantizar un servidor local activo" >&2
    exit 1
  }
  "$BIN" pull "$MODEL"
fi

echo "Ollama rootless instalado: $VERSION"
echo "Cloud Ollama deshabilitado; endpoint local: http://127.0.0.1:11434"
if [[ "$ENABLE" == "1" ]]; then
  echo "Servicio habilitado."
fi
if [[ "$PULL" == "1" ]]; then
  echo "Modelo disponible: $MODEL"
fi
