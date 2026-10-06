# Native Arch cutover

This runbook moves the operator checkout from the migration branch to native Arch `main`.
It does **not** authorize a PR merge, production deployment, external communication, runner deletion,
or removal of `AGENT_GLOBAL_PAUSE`.

## Invariants

- Keep `AGENT_GLOBAL_PAUSE=true` for the whole cutover.
- The PR must already be merged by an explicitly authorized human action before changing the local checkout.
- The local checkout must be clean.
- Never use `git reset --hard` for the initial cutover or rollback.
- Do not delete the legacy WSL clone or old GitHub runners during the cutover.
- Ollama can remain running because it is independent of the repository checkout.

## 1. Preflight

From the native Arch checkout:

```bash
cd ~/agente-automatizador
./scripts/native-cutover-check.sh pre
```

Required result:

```text
SUMMARY phase=pre failures=0 warnings=0
```

If any check fails, stop. Do not merge or change the local branch.

## 2. Human merge gate

Only after explicit authorization, merge PR #469 through the governed GitHub path.

After GitHub reports the PR as merged, verify it before touching the local checkout:

```bash
gh pr view 469 --repo palgarra14-del/agente-automatizador \
  --json state,mergedAt,mergeCommit,headRefOid,baseRefName
gh pr checks 469 --repo palgarra14-del/agente-automatizador
```

The base must be `main`, the PR checks must be successful, and GitHub must report a merge commit.

## 3. Fetch and verify remote main

```bash
cd ~/agente-automatizador
git fetch --no-tags origin main
git status --short
git branch --show-current
```

The workspace must still be clean and the branch must still be
`migration/native-linux-cutover`.

Verify that the GitHub-reported merge commit is contained in `origin/main` before continuing.

## 4. Quiesce only repository-code services

Keep the Actions runner and Ollama online. Stop only processes that execute files from this checkout:

```bash
systemctl --user stop engineering-orchestrator-cloud-heartbeat.timer
systemctl --user stop engineering-orchestrator-cloud-heartbeat.service
systemctl --user stop engineering-orchestrator-inbox.service
systemctl --user stop agent-control-tunnel.service
systemctl --user stop agent-control-center.service
```

The global pause remains the authority boundary even while these services are stopped.

## 5. Fast-forward local main

```bash
git switch main
git -c core.hooksPath=/dev/null merge --ff-only origin/main
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

The two SHAs must match and the workspace must be clean.

If the fast-forward fails, do not force it. Use the rollback section.

## 6. Sync the managed inbox and auto-upgrade

Persist only the approved non-secret provider configuration:

```bash
MODEL_COST_POLICY=subscription_included \
ANTIGRAVITY_CLI="$HOME/.local/bin/agy" \
CODEX_BIN=/usr/bin/codex \
OPENCODE_BIN=/usr/bin/opencode \
OPENCODE_FREE_TIMEOUT=90 \
node src/cli.js service sync
```

Expected state:

- inbox: enabled + active;
- verified auto-upgrade timer: enabled + active;
- no API keys/tokens rendered into systemd units.

## 7. Rebuild the native heartbeat from the repository

```bash
MODEL_COST_POLICY=subscription_included \
ANTIGRAVITY_CLI="$HOME/.local/bin/agy" \
CODEX_BIN=/usr/bin/codex \
OPENCODE_BIN=/usr/bin/opencode \
OPENCODE_FREE_TIMEOUT=90 \
./scripts/install-native-heartbeat.sh --enable
```

Run one heartbeat while still globally paused:

```bash
systemctl --user start engineering-orchestrator-cloud-heartbeat.service
journalctl --user -u engineering-orchestrator-cloud-heartbeat.service -n 30 --no-pager
```

It must report `globalPause: true` and dispatch nothing.

## 8. Restart observability

```bash
systemctl --user restart agent-control-center.service
systemctl --user restart agent-control-tunnel.service
```

Ollama should already remain online. Verify:

```bash
curl -fsS http://127.0.0.1:11434/api/version
ollama list
```

## 9. Post-cutover gate

```bash
cd ~/agente-automatizador
./scripts/native-cutover-check.sh post
```

Required result:

```text
SUMMARY phase=post failures=0 warnings=0
```

Do not remove the global pause until this passes.

## 10. Deferred cleanup

Only after the post-cutover gate and separate authorization:

- remove obsolete GitHub runner registrations for MSI/WSL;
- archive or delete `~/agente-native-linux` after one final backup decision;
- decide whether to retain the detached Browser QA worktree;
- remove `AGENT_GLOBAL_PAUSE` / set it to false when autonomous execution is explicitly approved.

## Rollback before unpausing

Rollback does not rewrite `main`; it returns the working checkout to the already-validated migration branch.

Keep `AGENT_GLOBAL_PAUSE=true`, then:

```bash
systemctl --user disable --now engineering-orchestrator-upgrade.timer
systemctl --user stop engineering-orchestrator-cloud-heartbeat.timer
systemctl --user stop engineering-orchestrator-inbox.service
systemctl --user stop agent-control-tunnel.service
systemctl --user stop agent-control-center.service

cd ~/agente-automatizador
git status --short
git switch migration/native-linux-cutover

systemctl --user start engineering-orchestrator-inbox.service
systemctl --user start engineering-orchestrator-cloud-heartbeat.timer
systemctl --user start agent-control-center.service
systemctl --user start agent-control-tunnel.service

./scripts/native-cutover-check.sh pre
```

If the workspace is not clean at any point, stop and inspect rather than forcing the branch change.
