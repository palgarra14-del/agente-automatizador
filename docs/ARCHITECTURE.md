# Architecture

## Engineering loop

`agent run` persists a run before acting. The deterministic planner emits a `CodingTask` containing an objective, repository context, constraints, and acceptance criteria. No second planner model is used, so `maxModelCalls` remains zero.

The orchestrator then verifies GitHub metadata and the local checkout, requires a clean `main`, fetches `origin/main`, compares that remote SHA with GitHub's inspected default-branch SHA, and creates `agent/<runId>` at that exact object. A mismatch fails as `base_head_changed`; it never uses `pull` or resets the caller branch. The worker can edit only the configured workspace. The orchestrator verifies that the worker did not alter Git history, validates changed paths, executes the project-configured checks, commits with a controlled message, pushes the working branch, creates a PR, polls CI, evaluates deterministic evidence, and reports the result.

The evaluation requires successful worker completion, a diff, test, typecheck, lint, build, commit, push, PR, and CI. A failed worker/check/CI can return to `working` only until `maxWorkerAttempts` is exhausted. A CI retry reuses the same branch and PR, pushes a new commit, and waits for CI again.

## Adapters

- `CodexSdkWorker`: real coding implementation through the official `@openai/codex-sdk`.
- `LocalGitAdapter`: explicit local Git operations only; no LLM-generated Git command strings.
- `GitHubAdapter`: authenticated repository/branch reads, PR creation, and check-run polling.
- `VercelDeploymentProvider`: placeholder only. v0.2 does not deploy or query Vercel yet.
- `MockCodingWorker`: test-only implementation.

## State and resume

`JsonStore` atomically replaces `.agent/state.json`. v0.2 is intentionally single-writer/single-process; do not run two orchestrator processes over the same state file. A resumed run reconstructs its project configuration and continues an approved PR creation or CI wait. The Codex SDK thread id is persisted with the worker result for future worker-level continuation.

Supported meaningful states are `working`, `testing`, `pushing`, `waiting_ci`, `evaluating`, `waiting_approval`, and `worker_failed_retryable`, plus terminal states. There is no in-memory-only continuation requirement.

## Dry run

`--dry-run` persists the run, plan, repository read, deterministic branch name, policy outcome, simulated worker/check/commit/push/PR/CI actions, and report. It performs no repository or GitHub write: no fetch, branch creation or switch, worker invocation, configured command, commit, push, PR creation, or deployment.
