# Architecture

## Engineering loop

`agent run` persists a run before acting. The deterministic planner emits a `CodingTask` containing an objective, repository context, constraints, and acceptance criteria. No second planner model is used, so `maxModelCalls` remains zero.

The orchestrator creates a dedicated managed workspace for registered projects, clones only their configured origin with a controlled Git invocation, verifies GitHub metadata and the cloned checkout, fetches `origin/main`, compares that remote SHA with GitHub's inspected default-branch SHA, and creates `agent/<runId>` at that exact object. A mismatch fails as `base_head_changed`; it never uses `pull` or resets a caller branch. It runs the configured install command before Codex, then lets the worker edit only that workspace. The orchestrator verifies that the worker did not alter Git history, validates changed paths, executes the project-configured checks, commits with a controlled message, pushes the working branch, creates a PR, polls CI, observes an optional read-only preview, evaluates deterministic evidence, and reports the result.

The evaluation requires successful worker completion, a governed diff, configured acceptance checks, commit, push, PR, and CI. A project can additionally require install and a Vercel deployment. v0.4 calculates file and line budgets, validates literal requested scope roots, rejects immutable forbidden paths, and classifies package/workflow/script/deployment/Dockerfile/security/auth changes as sensitive after the worker, after every configured check, and immediately before commit. The decision carries a SHA-256 fingerprint over paths, line counts, and hashed tracked/untracked content; raw diffs are never persisted. A sensitive approval binds to that fingerprint. Resume recalculates it before any command and marks the old approval stale if it differs; the final local commit also refuses any change set other than the final governed fingerprint. A failed worker/check/CI can return to `working` only until `maxWorkerAttempts` is exhausted. A CI retry reuses the same branch and PR, pushes a new commit, and waits for CI again.

## Adapters

- `CodexSdkWorker`: real coding implementation through the official `@openai/codex-sdk`.
- `LocalGitAdapter`: explicit local Git operations only; no LLM-generated Git command strings.
- `GitHubAdapter`: authenticated repository/branch reads, PR creation, and check-run polling.
- `WorkspaceManager`: isolated clone lifecycle beneath the managed root; successful and failed workspaces are retained for diagnosis.
- `VercelDeploymentProvider`: read-only Vercel deployment lookup and bounded polling by configured project/team, branch, and commit SHA.
- `MockCodingWorker`: test-only implementation.

## State and resume

`JsonStore` atomically replaces `.agent/state.json`. v0.3 is intentionally single-writer/single-process; do not run two orchestrator processes over the same state file. A resumed run reconstructs its project configuration and continues an approved PR creation, CI wait, or preview observation. The Codex SDK thread id is persisted with the worker result for future worker-level continuation.

Supported meaningful states are `working`, `testing`, `pushing`, `waiting_ci`, `evaluating`, `waiting_approval`, and `worker_failed_retryable`, plus terminal states. There is no in-memory-only continuation requirement.

## Dry run

`--dry-run` persists the run, plan, repository read, deterministic workspace and branch names, policy outcome, simulated install/worker/check/commit/push/PR/CI/preview actions, and report. It performs no repository or GitHub write: no workspace creation, clone, fetch, branch creation or switch, worker invocation, configured command, commit, push, PR creation, Vercel query, or deployment.

## Doctor and scope

`agent doctor --project <id>` has no write path. It reads the configured project and attempts the existing GitHub inspection, reporting connectivity and default-branch protection as `YES`, `NO`, or `UNKNOWN`; it also reports Codex SDK availability, workspace root, configured commands, Vercel configuration, and whether `VERCEL_TOKEN` is present without revealing any value.

`agent run` accepts repeated `--allowed-path` and `--forbidden-path` flags. Each value is one literal repository-relative root, persisted with the run and included in the worker task. It is not an instruction DSL; after worker completion the controlled Git adapter evaluates actual changed paths and cannot be bypassed by the task text.
