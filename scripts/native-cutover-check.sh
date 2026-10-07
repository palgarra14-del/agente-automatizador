#!/usr/bin/env bash
set -u

PHASE="${1:-pre}"
REPO="${AGENT_REPOSITORY:-palgarra14-del/agente-automatizador}"
PR_NUMBER="${AGENT_CUTOVER_PR:-469}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0
warnings=0

# Desktop/SSH/MCP shells can lack the user-manager bus even when linger keeps it
# alive. Reconstruct only the standard local bus coordinates; this checker stays
# read-only and never sources session state or credentials.
if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "$XDG_RUNTIME_DIR/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

case "$PHASE" in
  pre|post) ;;
  *) echo "Uso: $0 [pre|post]" >&2; exit 2 ;;
esac

ok() { printf 'OK   %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; warnings=$((warnings+1)); }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures+1)); }

check_active() {
  local unit="$1"
  if systemctl --user is-active --quiet "$unit"; then ok "$unit active"; else fail "$unit not active"; fi
}

check_enabled() {
  local unit="$1"
  if systemctl --user is-enabled --quiet "$unit"; then ok "$unit enabled"; else fail "$unit not enabled"; fi
}

cd "$ROOT" || exit 1

if [[ "$(uname -s)" == "Linux" ]] && [[ ! -r /proc/sys/fs/binfmt_misc/WSLInterop ]] && ! grep -qi microsoft /proc/version 2>/dev/null; then
  ok "native Linux host"
else
  fail "host is not native Linux"
fi

if [[ -z "$(git status --porcelain)" ]]; then ok "git workspace clean"; else fail "git workspace dirty"; fi

branch="$(git branch --show-current 2>/dev/null || true)"
if [[ "$PHASE" == "pre" ]]; then
  [[ "$branch" == "migration/native-linux-cutover" ]] && ok "pre-cutover branch is migration/native-linux-cutover" || fail "unexpected pre-cutover branch: $branch"
else
  [[ "$branch" == "main" ]] && ok "post-cutover branch is main" || fail "post-cutover branch is not main: $branch"
fi

if gh auth status >/dev/null 2>&1; then ok "GitHub CLI authenticated"; else fail "GitHub CLI authentication unavailable"; fi

pause="$(gh api "repos/$REPO/actions/variables/AGENT_GLOBAL_PAUSE" --jq .value 2>/dev/null || true)"
if [[ "$pause" =~ ^([Tt][Rr][Uu][Ee]|1|yes|on)$ ]]; then
  ok "global pause is enabled"
else
  fail "global pause is not enabled during cutover"
fi

if loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null | grep -qx yes; then
  ok "systemd user linger enabled"
else
  fail "systemd user linger disabled"
fi

if systemctl is-active --quiet docker.service; then ok "Docker active"; else fail "Docker inactive"; fi
if systemctl is-enabled --quiet docker.service; then ok "Docker enabled"; else fail "Docker not enabled"; fi

for unit in   actions-runner-arch.service   engineering-orchestrator-inbox.service   engineering-orchestrator-cloud-heartbeat.timer   agent-control-center.service   agent-control-tunnel.service
do
  check_active "$unit"
  check_enabled "$unit"
done

if systemctl --user cat ollama-local.service >/dev/null 2>&1; then
  ok "Ollama fallback unit installed"
else
  fail "Ollama fallback unit missing"
fi
if systemctl --user is-active --quiet ollama-local.service; then
  if curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
    ok "Ollama fallback active and healthy"
  else
    fail "Ollama fallback active but API unavailable"
  fi
else
  ok "Ollama fallback cold by policy"
fi

if [[ "$PHASE" == "pre" ]]; then
  if systemctl --user is-active --quiet engineering-orchestrator-upgrade.timer; then
    fail "auto-upgrade timer must stay inactive before cutover"
  else
    ok "auto-upgrade timer inactive before cutover"
  fi
else
  check_active engineering-orchestrator-upgrade.timer
  check_enabled engineering-orchestrator-upgrade.timer
fi

for cmd in node npm git gh codex opencode agy; do
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd available"; else fail "$cmd unavailable"; fi
done

if curl -fsS --max-time 4 http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q '"name":"qwen2.5-coder:3b"'; then
  ok "qwen2.5-coder:3b available"
else
  fail "qwen2.5-coder:3b missing"
fi

runner_json="$(gh api "repos/$REPO/actions/runners?per_page=100" 2>/dev/null || true)"
if [[ -n "$runner_json" ]] && python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if any(r.get("name")=="ARCH-orchestrator" and r.get("status")=="online" and any((l.get("name") if isinstance(l,dict) else l)=="agent-local" for l in r.get("labels",[])) for r in x.get("runners",[])) else 1)' <<<"$runner_json"; then
  ok "ARCH-orchestrator online with agent-local"
else
  fail "ARCH-orchestrator is not online with agent-local"
fi

if [[ "$PHASE" == "pre" ]]; then
  pr_state="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state,mergeable,headRefName --jq '[.state,.mergeable,.headRefName] | @tsv' 2>/dev/null || true)"
  if [[ "$pr_state" == $'OPEN\tMERGEABLE\tmigration/native-linux-cutover' ]]; then
    ok "PR #$PR_NUMBER open and mergeable"
  else
    fail "PR #$PR_NUMBER is not open/mergeable on migration branch: ${pr_state:-unavailable}"
  fi
  if gh pr checks "$PR_NUMBER" --repo "$REPO" >/dev/null 2>&1; then
    ok "PR #$PR_NUMBER checks successful"
  else
    fail "PR #$PR_NUMBER has pending or failing checks"
  fi
else
  remote_main="$(git ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}')"
  local_head="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$remote_main" && "$remote_main" == "$local_head" ]]; then
    ok "local main matches origin/main"
  else
    fail "local main does not match origin/main"
  fi
fi

if pgrep -af 'MSI-WSL|/mnt/c/|wsl.exe' >/dev/null 2>&1; then
  warn "legacy WSL-related local process detected"
else
  ok "no active legacy WSL process detected"
fi

printf '\nSUMMARY phase=%s failures=%d warnings=%d\n' "$PHASE" "$failures" "$warnings"
if (( failures > 0 )); then
  exit 1
fi
exit 0
