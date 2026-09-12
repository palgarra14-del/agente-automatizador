# Architecture

## Engineering loop

`agent run` persists a run before acting. The deterministic planner emits a `CodingTask` containing an objective, repository context, constraints, and acceptance criteria. No second planner model is used. Model-backed worker/analysis calls are governed separately by the persisted per-project `maxModelCalls` budget.

The orchestrator creates a dedicated managed workspace for registered projects, clones only their configured origin with a controlled Git invocation, verifies GitHub metadata and the cloned checkout, fetches `origin/main`, compares that remote SHA with GitHub's inspected default-branch SHA, and creates `agent/<runId>` at that exact object. A mismatch fails as `base_head_changed`; it never uses `pull` or resets a caller branch. It runs the configured install command before Codex, then lets the worker edit only that workspace. The orchestrator verifies that the worker did not alter Git history, validates changed paths, executes the project-configured checks, commits with a controlled message, pushes the working branch, creates a PR, polls CI, observes an optional read-only preview, evaluates deterministic evidence, and reports the result.

The evaluation requires successful worker completion, a governed diff, configured acceptance checks, commit, push, PR, and CI. A project can additionally require install and a Vercel deployment. v0.4 calculates file and line budgets, validates literal requested scope roots, rejects immutable forbidden paths, and classifies package/workflow/script/deployment/Dockerfile/security/auth changes as sensitive after the worker, after every configured check, and immediately before commit. The decision carries a SHA-256 fingerprint over paths, line counts, and hashed tracked/untracked content; raw diffs are never persisted. A sensitive approval binds to that fingerprint. Resume recalculates it before any command and marks the old approval stale if it differs; the final local commit also refuses any change set other than the final governed fingerprint. A failed worker/check/CI can return to `working` only until `maxWorkerAttempts` is exhausted. A CI retry reuses the same branch and PR, pushes a new commit, and waits for CI again.

## v0.7 capability boundary

`ToolSkillRegistry` is the capability contract between planning and execution. Atomic tools declare a stable binding name, supported surfaces, and risk. Skills declare required tools plus a versioned input/output contract. The registry fingerprint covers executable contract fields rather than descriptive prose, and the registry internals are not externally mutable.

Each configured project receives a normalized skill allow/deny policy. Deny wins over allow. A project-policy fingerprint and registry fingerprint are persisted on both Orchestrator runs and workflow plans; resume fails closed if either changes. The Orchestrator performs a lifecycle preflight before real work and also enforces individual skill gates immediately before workspace preparation, bootstrap/check execution, coding, push/PR publication, CI observation, preview observation, and human approval. Workflow execution resolves the visible step skill plus infrastructure skills such as `workspace.prepare` and `project.bootstrap` before clone/install.

The registry distinguishes `workflow` and `orchestrator` surfaces. Reviewed WorkflowEngine executors now cover `code.inspect`, `code.diagnose`, governed `code.implement`, independent `code.review`, and v0.13's read-only `website.plan`. Web research, automatic visual review, and data-analysis model execution remain unavailable until reviewed executors exist.

## v0.8 execution integration

Execution leases are persisted on runs and workflows. A live owner rejects a second invocation before duplicate planner/worker/command work begins; an abandoned owner is recoverable only through the existing conservative process-identity check. Lease loss/tampering fails closed, and success/error paths release the matching lease.

The first WorkflowEngine skill executors are deliberately split by authority. `CodexReadOnlySkillExecutor` handles `code.inspect` and `code.diagnose` with a fail-closed read-only Codex permission profile, isolated HOME, no network/browser/plugins/project instructions, strict JSON contracts, and independent before/after integrity checks. Those checks bind repository identity, branch/HEAD/remote, working-tree fingerprint, protected ignored files, and Git control metadata (including refs/reflogs/hooks/info).

`code.implement` reuses `CodexSdkWorker` rather than adding a second writer. The WorkflowEngine captures the clean starting repository state, runs the worker with only sanitized goal/evidence/scope, then reuses `LocalGitAdapter.inspectChangeSet` and `evaluateChangePolicy`. Forbidden paths, scope violations, and change-budget violations fail; a failed worker that left changes blocks rather than retrying. v0.8 originally blocked sensitive changes; v0.12 adds a fingerprint-bound human approval path that revalidates the complete governed workspace before a sensitive implementation can become completed. Tests/typecheck/lint/build remain configured verification commands. v0.11 adds the separate reviewed-publication boundary described below. Merge and production deployment remain unavailable.

Crash recovery records the pre-execution branch, HEAD, remote, workspace, change-set fingerprint, protected ignored-file fingerprint, and Git-control fingerprint. An interrupted worker may be retried only when all governed state is still clean; observed changes or repository/control-state mutation become a non-approvable block so work is never silently applied twice.

## v0.9 specialist and review boundary

`SpecialistRegistry` assigns an explicit logical owner to every deterministic workflow step. The registry contract fingerprints specialist id, mode, skills, authority, and executor. Non-reserved specialists must have a workflow-bound skill whose risk matches their declared authority class; a read-only specialist therefore cannot be configured to own `code.implement`. Reserved specialists may own only skills whose execution surface is still unavailable.

The app-improvement flow is `inspect → diagnose → human plan checkpoint → implement → change critic → tests → verification → human release-readiness checkpoint`. The Change Critic uses a fresh read-only execution thread, receives governed implementation evidence, inspects the real current repository diff and surrounding code, and returns a strict `PASS` or `FAIL` review contract. Its evidence is bound to the implementation change-set fingerprint. Tests cannot start without a valid PASS, and the existing repository/diff integrity checks still run after review and during verification.

## v0.10 model budget and usage accounting

Each run/workflow persists a `modelUsage` ledger with a fixed `maxCalls` copied from the active project budget. Before a model-backed operation starts, the orchestrator reserves an entry containing surface, skill, workflow step, specialist, and attempt. Reservation happens before invocation, so a crash cannot make an uncertain call disappear from accounting. Exhaustion fails before another model call is invoked.

When the SDK returns usage evidence, input/output token counts are normalized and accumulated; missing or malformed usage does not erase the call and increments `unknownUsageCalls`. Resume validates the persisted ledger against the current project budget and fails closed on missing, inconsistent, over-budget, or tampered state. This is a real call-count governor and an auditable usage ledger, not yet an exact monetary spend cap.

## v0.11 reviewed workflow publication

The app-improvement flow now ends with `release-readiness → publication`. Publication is not a general Git/GitHub capability grant. `release.publish-reviewed-workflow` depends on one workflow-only tool, `workflow-publication`, owned by the `release-manager` specialist with `external-write` authority. Low-level `git-publish`, `github-publish`, `github-observe`, and `vercel-observe` remain Orchestrator-only.

A publication-capable workflow must use a managed workspace. During workspace initialization, controlled Git fetches the configured default branch and creates `agent/<workflowId>` at the exact persisted base SHA before any model-backed step runs. The workflow persists branch/base/remote evidence and revalidates it whenever the workspace is reused.

Publication prerequisites are exact: implementation, critic PASS, configured verification, and human release-readiness approval must all point to the same change-set fingerprint. Immediately before publication the change set and repository-control evidence are recalculated. The GitHub default-branch head must still equal the persisted base before commit, again after push before PR creation, and again after CI/preview. Base drift invalidates publication rather than silently rebasing reviewed code.

External writes are a persisted state machine: preflight → commit-started/committed → push-started/pushed → pr-started/pr-created → CI observation → optional preview observation → final revalidation. Commit must contain exactly the governed paths/fingerprint; push and remote branch must point to the commit SHA; the PR must be open with the exact head SHA/ref and configured base. CI must succeed. Projects whose acceptance requires deployment must also expose a READY non-production preview for the same commit and branch.

A crash during commit, push, or PR creation becomes an uncertain external-write block and is never replayed automatically. Only read-only CI/preview timeout states are resumable, and resume first revalidates base, remote branch, and PR identity. No WorkflowPublicationBridge method exists for merge, promotion, production deploy, domain changes, environment changes, or secret writes.

## v0.12 sensitive and dependency-change boundary

The app-improvement graph is now `inspect → diagnose → plan approval → implement → dependency refresh → change critic → tests → verification → release approval → publication`. For a normal diff, dependency refresh is a deterministic no-op and does not resolve or request the network capability. For a sensitive diff, implementation remains paused until an explicit approval is bound to the exact SHA-256 change-set fingerprint. Immediately before approval, WorkflowEngine rechecks repository identity, branch/HEAD/remote, Git-control fingerprint, protected ignored-file fingerprint, the full change policy, and the exact diff. Any drift makes the approval stale.

Dependency manifests and lockfiles are recognized at the repository root and in nested workspace paths. Approved dependency metadata triggers `project.dependencies.refresh`, owned by the dedicated `dependency-manager` specialist. The configured command is validated twice—at config load and immediately before execution—and may only be `npm ci --ignore-scripts` or `pnpm install --frozen-lockfile --ignore-scripts` for the configured toolchain. The stage requires `container-required`; local-sanitized execution is denied.

Docker network access remains denied for ordinary post-worker commands. The only post-worker network exception is the explicit `dependency-refresh` stage, and only the `dependencyRefresh` command may enter it. Completion persists and validates observed execution evidence (`provider=container`, `stage=dependency-refresh`, explicit refresh-network label). The before/after workspace snapshots must be identical, covering repository identity, branch/HEAD, Git controls, governed diff fingerprint, and protected ignored files. Package-manager control files (`.npmrc`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, Yarn rc files) are immutable/protected so a model cannot redirect registry or resolver behavior before this networked stage. No lifecycle scripts are allowed.

## v0.13 structured website-build boundary

`website-build` is a registered-project workflow, not an arbitrary repository generator. Creation requires normalized `input.businessBrief`; the plan persists the normalized brief plus a SHA-256 fingerprint and fails closed if either is later changed. The CLI accepts the brief only from a regular non-symlink JSON file up to 64 KiB and reads it through a validated file handle whose identity/version is rechecked after reading.

Before `website.plan`, declared logo/photo paths are resolved inside the managed workspace, checked through the safe path chain, required to be regular non-symlink files, bounded to 20 MiB each / 200 MiB total, streamed through SHA-256, and persisted as asset evidence. This happens before model-call reservation. The read-only planner runs with web search disabled and receives the brief, its fingerprint, verified asset evidence, and repository context. Its strict plan schema covers pages, design, conversion, SEO, implementation constraints, and missing inputs. Unsupported primary SEO locations fail context validation rather than becoming persisted plan state.

The website graph is `requirements → design approval → implementation → dependency refresh → change critic → quality → release-readiness approval → publication/CI/preview → human visual approval`. Design approval stores the exact website-plan fingerprint. Before implementation the engine re-hashes assets and blocks if they changed; assets are hashed through stable validated file handles and are revalidated again after Codex. The coding task receives the authoritative business brief, approved plan, and bound fingerprints, while model prompts explicitly treat all supplied context as untrusted data and forbid fabricated business claims. Sensitive package changes reuse v0.12 approval and frozen refresh without rerunning the coding worker.

Before the critic spends a model call, the engine revalidates that the current diff/Git/protected state still equals the implementation fingerprint. The critic must PASS that exact diff and, for website builds, independently compare business-specific claims with the authoritative brief/plan/assets. Quality requires test/typecheck/lint/build and continuous change-set governance rejects command-induced drift. Release-readiness binds to the reviewed fingerprint and permits publication. Website publication requires successful CI plus a READY non-production preview with URL for the exact commit; only then can visual approval persist the exact change fingerprint, commit SHA, and preview URL. Publication still exposes no merge or production method. v0.13 deliberately leaves browser-based visual inspection to a later reviewed capability; human visual approval is not represented as automated visual QA.

## v0.14 supervised issue control plane

The issue queue is an operator/control plane around WorkflowEngine, not a new execution engine. A local `agent inbox once|watch` process polls one configured GitHub repository with the orchestrator's `GITHUB_TOKEN`; Codex remains local under the existing isolated worker boundary. v0.14 initially accepts only `app-improvement` requests and requires explicit bounded allowed paths.

A request body is strict versioned JSON preceded by a unique marker. It is normalized, secret-masked where appropriate, SHA-256 fingerprinted, and atomically reserved in `JsonStore` before workflow creation. The first executable action is always `WorkflowEngine.run(..., { dryRun: true })`; no model call, project write, Git write, PR or deployment occurs. A start token binds the request, workflow capability/specialist fingerprints, scope, complete dry-run step graph, and declared external writes. The queue rechecks current GitHub comments for an exact approval from an allowlisted actor before a pristine workflow may run, so corrupting local queue status cannot invent start authorization.

Each later WorkflowEngine human checkpoint is approved only through its own fingerprint over persisted workflow/step state. Issue-body edits and stale fingerprints fail closed. Initialization has a process-identity lease so concurrent watchers cannot create duplicate workflows; abandoned initialization becomes a manual block. After creation, WorkflowEngine's existing execution lease prevents duplicate model/executor work. Safe CI/preview observation timeouts may resume; uncertain external-write states keep the v0.11 non-replay behavior.

The queue never merges, never promotes/deploys production, and never bypasses capability/project/change policy. It intentionally processes one active request per polling tick; parallel remote workers remain deferred until the single-worker dogfood path is proven.

## Adapters

- `CodexSdkWorker`: real workspace-write coding implementation through the official `@openai/codex-sdk`.
- `CodexReadOnlySkillExecutor`: workflow-only read-only inspection/diagnosis with strict JSON output and no network/web search.
- `LocalGitAdapter`: explicit local Git operations only; no LLM-generated Git command strings.
- `GitHubAdapter`: authenticated repository/branch reads, PR creation, and check-run polling.
- `ToolSkillRegistry`: immutable deterministic registry of tool bindings, skill contracts, project policy, surface availability, and fingerprints.
- `WorkspaceManager`: isolated clone lifecycle beneath the managed root; fresh clones explicitly checkout the configured base branch, valid interrupted clones are reused only when clean and repository-matched, and partial/mismatched clones are retained under a `.failed-*` sibling before recovery.
- `WorkflowPublicationBridge`: workflow-only façade over controlled commit/push/PR/CI/preview operations; deliberately exposes no merge or production action.
- `VercelDeploymentProvider`: read-only Vercel deployment lookup and bounded polling by configured project/team, branch, and commit SHA.
- `ProjectCommandRunner`: selects only the project-configured execution provider; a worker cannot choose it.
- `DockerContainerExecution`: real Docker boundary for `container` and `container-required`, with only an explicit workspace bind mount and no automatic image pull.
- `LocalSanitizedExecution`: an explicit, less-isolated fallback for projects that deliberately select it.
- `MockCodingWorker`: test-only implementation.

## v0.5 command execution boundary

`execution.provider` is one of `container-required`, `container`, or `local-sanitized`. Registered projects use `container-required` with a configured literal image name. Docker availability and local-image availability are checked with read-only CLI probes, and command execution uses `--pull never`. The orchestrator never downloads an image. If a `container-required` provider is unavailable, the command fails as `execution_provider_unavailable`; it never silently falls back to the host. A `container` provider can use `local-sanitized` only when `fallbackProvider: "local-sanitized"` is explicit in configuration.

Post-worker container commands run shell-free with an explicit `/workspace` bind mount, `--network none`, `--read-only`, `/tmp` as a bounded tmpfs, dropped capabilities, `no-new-privileges`, numeric non-root identity, memory/CPU/PID limits, and command timeout. No HOME, SSH, Git, Codex, orchestrator credential, or Docker-socket mount is created. Bootstrap `install`, before the worker, may use the default container network. v0.12 adds exactly one reviewed post-worker exception: `dependency-refresh`, after fingerprint-bound approval, for one frozen no-lifecycle-script command. Every ordinary post-worker verification command still receives `--network none`.

`local-sanitized` keeps the prior shell-free and credential-sanitized process environment but is deliberately reported by doctor as not container-isolated: host filesystem and network enforcement are weaker. It is an explicit compatibility choice, not a simulation of the container contract.

## State and resume

`JsonStore` atomically replaces `.agent/state.json` and protects mutations with a filesystem lock. Concurrent writers serialize through that lock, and stale locks whose owning process is demonstrably dead can be recovered conservatively. A resumed run reconstructs its project configuration and continues an approved PR creation, CI wait, or preview observation. Workflow plans separately persist capability-registry/policy fingerprints, exact step skills, their managed workspace, bootstrap evidence, active-execution deadline, checkpoint pause timestamp, step evidence, and Definition of Done state. The Codex SDK thread id is persisted with the worker result for future worker-level continuation.

Supported meaningful states are `working`, `testing`, `pushing`, `waiting_ci`, `evaluating`, `waiting_approval`, and `worker_failed_retryable`, plus terminal states. There is no in-memory-only continuation requirement.

## Dry run

`--dry-run` persists the run, plan, repository read, deterministic workspace and branch names, policy outcome, required capability resolutions, simulated install/worker/check/commit/push/PR/CI/preview actions, and report. It performs no repository or GitHub write: no workspace creation, clone, fetch, branch creation or switch, worker invocation, configured command, commit, push, PR creation, Vercel query, or deployment.

## Doctor and scope

`agent doctor --project <id>` has no write path. It reads the configured project and attempts the existing GitHub inspection, reporting connectivity and default-branch protection as `YES`, `NO`, or `UNKNOWN`; it also reports Codex SDK availability, workspace root, configured commands, Vercel configuration, whether `VERCEL_TOKEN` is present, configured/selected execution provider, Docker availability, post-worker network policy, and host fallback without revealing any value.

`agent run` and `agent workflow create` accept repeated `--allowed-path` and `--forbidden-path` flags. Each value is one literal repository-relative root, persisted with the run and included in the worker task. It is not an instruction DSL; after worker completion the controlled Git adapter evaluates actual changed paths and cannot be bypassed by the task text.
