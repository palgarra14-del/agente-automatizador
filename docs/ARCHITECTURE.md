# Architecture

## Engineering loop

`agent run` persists a run before acting. The deterministic planner emits a `CodingTask` containing an objective, repository context, constraints, and acceptance criteria. No second planner model is used, so `maxModelCalls` remains zero.

The orchestrator creates a dedicated managed workspace for registered projects, clones only their configured origin with a controlled Git invocation, verifies GitHub metadata and the cloned checkout, fetches `origin/main`, compares that remote SHA with GitHub's inspected default-branch SHA, and creates `agent/<runId>` at that exact object. A mismatch fails as `base_head_changed`; it never uses `pull` or resets a caller branch. It runs the configured install command before Codex, then lets the worker edit only that workspace. The orchestrator verifies that the worker did not alter Git history, validates changed paths, executes the project-configured checks, commits with a controlled message, pushes the working branch, creates a PR, polls CI, observes an optional read-only preview, evaluates deterministic evidence, and reports the result.

The evaluation requires successful worker completion, a governed diff, configured acceptance checks, commit, push, PR, and CI. A project can additionally require install and a Vercel deployment. v0.4 calculates file and line budgets, validates literal requested scope roots, rejects immutable forbidden paths, and classifies package/workflow/script/deployment/Dockerfile/security/auth changes as sensitive after the worker, after every configured check, and immediately before commit. The decision carries a SHA-256 fingerprint over paths, line counts, and hashed tracked/untracked content; raw diffs are never persisted. A sensitive approval binds to that fingerprint. Resume recalculates it before any command and marks the old approval stale if it differs; the final local commit also refuses any change set other than the final governed fingerprint. A failed worker/check/CI can return to `working` only until `maxWorkerAttempts` is exhausted. A CI retry reuses the same branch and PR, pushes a new commit, and waits for CI again.

## v0.7 capability boundary

`ToolSkillRegistry` is the capability contract between planning and execution. Atomic tools declare a stable binding name, supported surfaces, and risk. Skills declare required tools plus a versioned input/output contract. The registry fingerprint covers executable contract fields rather than descriptive prose, and the registry internals are not externally mutable.

Each configured project receives a normalized skill allow/deny policy. Deny wins over allow. A project-policy fingerprint and registry fingerprint are persisted on both Orchestrator runs and workflow plans; resume fails closed if either changes. The Orchestrator performs a lifecycle preflight before real work and also enforces individual skill gates immediately before workspace preparation, bootstrap/check execution, coding, push/PR publication, CI observation, preview observation, and human approval. Workflow execution resolves the visible step skill plus infrastructure skills such as `workspace.prepare` and `project.bootstrap` before clone/install.

The registry distinguishes `workflow` and `orchestrator` surfaces. v0.8 binds reviewed workflow executors for `code.inspect`, `code.diagnose`, and the app-improvement `code.implement` path. Future research, visual review, requirements, and data-analysis capabilities remain declared but unavailable until reviewed executors exist.

## v0.8 execution integration

Execution leases are persisted on runs and workflows. A live owner rejects a second invocation before duplicate planner/worker/command work begins; an abandoned owner is recoverable only through the existing conservative process-identity check. Lease loss/tampering fails closed, and success/error paths release the matching lease.

The first WorkflowEngine skill executors are deliberately split by authority. `CodexReadOnlySkillExecutor` handles `code.inspect` and `code.diagnose` with a fail-closed read-only Codex permission profile, isolated HOME, no network/browser/plugins/project instructions, strict JSON contracts, and independent before/after integrity checks. Those checks bind repository identity, branch/HEAD/remote, working-tree fingerprint, protected ignored files, and Git control metadata (including refs/reflogs/hooks/info).

`code.implement` reuses `CodexSdkWorker` rather than adding a second writer. The WorkflowEngine captures the clean starting repository state, runs the worker with only sanitized goal/evidence/scope, then reuses `LocalGitAdapter.inspectChangeSet` and `evaluateChangePolicy`. Forbidden paths, scope violations, and change-budget violations fail; sensitive changes block; a failed worker that left changes blocks rather than retrying. Only a completed worker plus a normal policy decision and bound change-set fingerprint can satisfy implementation evidence. Tests/typecheck/lint/build remain configured verification commands. WorkflowEngine never commits, pushes, creates PRs, merges, or deploys.

Crash recovery records the pre-execution branch, HEAD, remote, workspace, change-set fingerprint, protected ignored-file fingerprint, and Git-control fingerprint. An interrupted worker may be retried only when all governed state is still clean; observed changes or repository/control-state mutation become a non-approvable block so work is never silently applied twice.

## Adapters

- `CodexSdkWorker`: real workspace-write coding implementation through the official `@openai/codex-sdk`.
- `CodexReadOnlySkillExecutor`: workflow-only read-only inspection/diagnosis with strict JSON output and no network/web search.
- `LocalGitAdapter`: explicit local Git operations only; no LLM-generated Git command strings.
- `GitHubAdapter`: authenticated repository/branch reads, PR creation, and check-run polling.
- `ToolSkillRegistry`: immutable deterministic registry of tool bindings, skill contracts, project policy, surface availability, and fingerprints.
- `WorkspaceManager`: isolated clone lifecycle beneath the managed root; fresh clones explicitly checkout the configured base branch, valid interrupted clones are reused only when clean and repository-matched, and partial/mismatched clones are retained under a `.failed-*` sibling before recovery.
- `VercelDeploymentProvider`: read-only Vercel deployment lookup and bounded polling by configured project/team, branch, and commit SHA.
- `ProjectCommandRunner`: selects only the project-configured execution provider; a worker cannot choose it.
- `DockerContainerExecution`: real Docker boundary for `container` and `container-required`, with only an explicit workspace bind mount and no automatic image pull.
- `LocalSanitizedExecution`: an explicit, less-isolated fallback for projects that deliberately select it.
- `MockCodingWorker`: test-only implementation.

## v0.5 command execution boundary

`execution.provider` is one of `container-required`, `container`, or `local-sanitized`. Registered projects use `container-required` with a configured literal image name. Docker availability and local-image availability are checked with read-only CLI probes, and command execution uses `--pull never`. The orchestrator never downloads an image. If a `container-required` provider is unavailable, the command fails as `execution_provider_unavailable`; it never silently falls back to the host. A `container` provider can use `local-sanitized` only when `fallbackProvider: "local-sanitized"` is explicit in configuration.

Post-worker container commands run shell-free with an explicit `/workspace` bind mount, `--network none`, `--read-only`, `/tmp` as a bounded tmpfs, dropped capabilities, `no-new-privileges`, numeric non-root identity, memory/CPU/PID limits, and command timeout. No HOME, SSH, Git, Codex, orchestrator credential, or Docker-socket mount is created. Only bootstrap `install`, before the worker, is allowed the default container network; it is not in the post-worker check list and is never automatically repeated after the worker modifies package metadata.

`local-sanitized` keeps the prior shell-free and credential-sanitized process environment but is deliberately reported by doctor as not container-isolated: host filesystem and network enforcement are weaker. It is an explicit compatibility choice, not a simulation of the container contract.

## State and resume

`JsonStore` atomically replaces `.agent/state.json` and protects mutations with a filesystem lock. Concurrent writers serialize through that lock, and stale locks whose owning process is demonstrably dead can be recovered conservatively. A resumed run reconstructs its project configuration and continues an approved PR creation, CI wait, or preview observation. Workflow plans separately persist capability-registry/policy fingerprints, exact step skills, their managed workspace, bootstrap evidence, active-execution deadline, checkpoint pause timestamp, step evidence, and Definition of Done state. The Codex SDK thread id is persisted with the worker result for future worker-level continuation.

Supported meaningful states are `working`, `testing`, `pushing`, `waiting_ci`, `evaluating`, `waiting_approval`, and `worker_failed_retryable`, plus terminal states. There is no in-memory-only continuation requirement.

## Dry run

`--dry-run` persists the run, plan, repository read, deterministic workspace and branch names, policy outcome, required capability resolutions, simulated install/worker/check/commit/push/PR/CI/preview actions, and report. It performs no repository or GitHub write: no workspace creation, clone, fetch, branch creation or switch, worker invocation, configured command, commit, push, PR creation, Vercel query, or deployment.

## Doctor and scope

`agent doctor --project <id>` has no write path. It reads the configured project and attempts the existing GitHub inspection, reporting connectivity and default-branch protection as `YES`, `NO`, or `UNKNOWN`; it also reports Codex SDK availability, workspace root, configured commands, Vercel configuration, whether `VERCEL_TOKEN` is present, configured/selected execution provider, Docker availability, post-worker network policy, and host fallback without revealing any value.

`agent run` and `agent workflow create` accept repeated `--allowed-path` and `--forbidden-path` flags. Each value is one literal repository-relative root, persisted with the run and included in the worker task. It is not an instruction DSL; after worker completion the controlled Git adapter evaluates actual changed paths and cannot be bypassed by the task text.
