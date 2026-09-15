# Security

## Authority boundaries

The CodingWorker edits code only. The Orchestrator owns repository identity, workspace, branch policy, budgets, configured checks, commits, pushes, GitHub writes, CI polling, and state persistence. The worker prompt expressly prohibits Git history/remote operations, deployment, secret handling, and policy changes.

The official SDK workers use an explicit fail-closed Codex permission profile rather than trusting the prompt alone. The profile denies root reads, grants only the requested workspace authority (read-only analysis or workspace-write implementation), keeps `.git` read-only, disables network, login shells, browser/computer use, plugins/connectors/hooks, memories, collaboration/multi-agent features, and project instruction loading. Each invocation receives a private temporary HOME/CODEX_HOME containing only the minimum Codex authentication material with restrictive permissions; GitHub, Vercel and other orchestration credentials are not inherited or included in the task. Unsupported native platforms fail before constructing the Codex client.

## Capability policy

v0.7 adds an immutable Tool/Skill Registry as an additional authority boundary. Project configuration contains explicit skill allow/deny policy; deny takes precedence. A skill is executable only when policy allows it, its declared surface matches the caller, and every required tool has a reviewed binding on that surface. Reserved future capabilities are represented but remain unavailable.

The registry fingerprint covers executable bindings, surfaces, risks, dependencies, and versioned input/output contracts. The normalized project-policy fingerprint is persisted with each run/workflow. Resume fails closed if either fingerprint changes, preventing a saved task from silently gaining permissions after a registry or project-policy update. Real Orchestrator actions still re-check the specific skill immediately before the operation; the preflight is defense in depth, not the sole gate.

## v0.8 workflow execution

Workflow read-only analysis and workspace-write implementation are separate authority levels. `code.inspect` and `code.diagnose` run with the read-only Codex permission profile. The engine independently snapshots repository identity, branch, HEAD, remote, working-tree content, protected ignored-file metadata, and Git control state before/after execution; any mutation fails closed even if the model reports success.

`code.implement` reuses the existing `CodexSdkWorker` in workspace-write mode. It receives sanitized workflow evidence and optional literal path scope, but no GitHub/Vercel/OpenAI token values. After execution, controlled Git code reasserts branch/HEAD/remote and evaluates actual changed paths/content with the existing immutable-path, scope, sensitive-change, and size budgets. A normal governed change advances deterministically. Since v0.12, a sensitive change may advance only after explicit fingerprint-bound approval and full workspace revalidation; forbidden/over-budget changes still fail, and a failed/timed-out worker that left files changed cannot be retried automatically.

The v0.8 execution path stopped before commit/push/PR. v0.11 adds only the dedicated reviewed-publication capability described below; merge, production deployment, domain/environment/secret mutation, and destructive/data actions remain unavailable. Persisted execution leases prevent concurrent run/resume/approval from duplicating the same worker/command sequence. Interrupted worker or critic state records its starting repository identity; if recovery observes changes or repository-state mutation, retry is blocked.

## Specialist and model-use integrity

Specialist identity is evidence, not a permission source. Project skill policy remains authoritative, specialist mode must match the assigned skill risk, and specialist-registry fingerprints bind saved workflows to the reviewed specialist contract. Change Critic PASS evidence is structurally validated, tied to the exact implementation change-set fingerprint, and cannot authorize repository writes.

Model-use accounting is also fail-closed. Saved runs/workflows must contain a model ledger whose maximum matches the active project configuration. Calls are reserved before execution; retries consume additional reservations; exceeding the cap stops before another model-backed executor runs. Reported token counts are evidence only and are never trusted to reduce the call count.

## Structured website input and planning boundary

`website-build` accepts business data only through a bounded structured brief. Unknown fields, excessive lengths/counts, repository path escapes, and malformed brand colors are rejected before execution. The CLI reads the brief through a stable regular-file handle with size/identity/version checks rather than a separate check-then-read path. The normalized brief and its fingerprint are persisted as workflow evidence. Secret-shaped keys/values still pass through structured redaction, and all supplied brief/plan/evidence text is explicitly treated as untrusted data by model prompts.

Declared website assets are not trusted merely because the brief names them. Before the planner consumes a model call, each asset must resolve inside the managed workspace without a symlink chain, be a regular file, remain within size budgets, and receive a SHA-256 fingerprint. Assets are re-read before implementation; any substitution after design approval blocks before the coding worker starts.

`website.plan` uses the same isolated read-only Codex boundary as other analysis skills, with network/web search disabled. The prompt forbids unsupported testimonials, credentials, awards, guarantees, pricing, clients, service areas, and similar claims, while the output schema requires a `missingInputs` channel. Deterministic context validation additionally prevents the planner from selecting a primary SEO location absent from the supplied business locations. The requirements specialist has read-only authority only and cannot implement or publish.

Human design approval is tied to the plan fingerprint. Release-readiness approval is tied to the independently reviewed implementation fingerprint and authorizes review-only publication, not merge or production. For website builds, publication must produce successful CI and a usable READY non-production preview for the exact commit. Human visual approval occurs only afterward and is bound simultaneously to the implementation fingerprint, published commit SHA, and exact preview URL. A modified persisted approval cannot authorize a different plan, diff, commit, or preview. Visual review remains human in v0.13; no browser automation is silently implied.

## Supervised issue-channel boundary

GitHub issues/comments are untrusted remote input until normalized and authorized. The queue accepts one strict request schema, caps request/config sizes, rejects unknown fields and repository-root/unbounded scopes, and permits only registered project IDs plus the existing `app-improvement` profile. The issue author and every approval author must match an explicit login allowlist. Approval syntax is exact, so quoted status text or embedded instructions cannot self-approve.

An issue request is not execution authority. The queue first creates only a WorkflowEngine dry-run and posts its fingerprint. A pristine workflow may run only while a matching current GitHub approval comment exists for that exact dry-run fingerprint. Subsequent checkpoint/sensitive approvals are newly fingerprinted against persisted workflow state. Editing the issue invalidates the request; stale approvals fail closed. Local request state is validated and cannot by itself manufacture the initial approval.

Issue initialization is atomically single-owner through the private JSON-store lock plus a process-identity lease. A second watcher cannot create a second workflow, and abandoned initialization blocks rather than retrying. Once a workflow exists, the WorkflowEngine execution lease remains the duplicate-execution boundary. The watcher may retry transport/API failures, but deterministic initialization failures are persisted as blocked; only CI/preview observation timeouts inherit the existing safe read-only resume path.

The issue adapter needs `GITHUB_TOKEN` in the local orchestrator process to read/write issues. That token is never copied to the Codex worker environment or structured coding task. Status comments omit goals/secrets and expose only bounded workflow/approval/publication facts. The issue queue adds no merge, production deployment, arbitrary repository selection, arbitrary command execution, or secret-management path.

## Governed dependency-refresh boundary

Network access after the coding worker is exceptional, not general. `project.dependencies.refresh` is workflow-only and has a dedicated `dependency-manager` authority. It is evaluated only when the approved implementation changes a root or nested package manifest/lockfile. Normal changes complete the stage as a no-op before capability resolution, so they do not acquire network authority.

The refresh command is literal configuration, never model output. npm is restricted to `npm ci --ignore-scripts`; pnpm is restricted to `pnpm install --frozen-lockfile --ignore-scripts`. Configuration and runtime both require `container-required`, and the Docker executor accepts network in the `dependency-refresh` stage only for the `dependencyRefresh` command. Successful evidence must attest that exact container/stage/network boundary. Any workspace/Git/protected-file mutation caused by the refresh fails the workflow.

Package-manager control files including nested `.npmrc`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, and Yarn rc files are immutable and included in protected ignored-file monitoring. This prevents the worker from changing registries, hooks, workspace resolver configuration, or similar controls immediately before the networked dependency step. Projects without an approved frozen refresh command block rather than falling back to a mutable install.

## Reviewed publication boundary

`release.publish-reviewed-workflow` is the only external-write skill exposed to WorkflowEngine. It depends on a single `workflow-publication` binding; the lower-level Git/GitHub/Vercel publisher/observer tools remain unavailable on the workflow surface. Project allow/deny policy, registry fingerprinting, specialist authority checks, and execution leases apply before publication.

Publication requires a managed workspace and an `agent/<workflowId>` branch created from the exact configured default-branch SHA. Release approval is fingerprint-bound to the Change Critic-reviewed implementation. The worktree, protected ignored files, Git control state, branch, remote, change-set fingerprint, and current GitHub default-branch SHA are revalidated before writes. Default-branch drift before PR or before completion fails closed.

The external-write sequence is persisted around each irreversible phase. If execution is interrupted while commit, push, or PR creation may have occurred, state becomes uncertain and cannot be approved/retried automatically. Only CI/preview observations are safe to resume; they do not repeat commit/push/PR and first revalidate the remote branch and PR against the recorded commit SHA.

A completed publication requires exact commit-path/fingerprint evidence, remote-branch SHA equality, an open PR with exact head/base identity, and successful CI. Website builds additionally require a READY preview with a non-empty URL for that same non-production commit/branch regardless of looser project acceptance settings; without it the visual checkpoint is unreachable. Publication completion never implies merge or production deployment.

## Git and paths

- Only an ID in `config/projects.json` is eligible for a run; the LLM cannot supply the repository URL, owner, repo, workspace root, or branch pattern.
- Managed workspaces must resolve below `.agent-workspaces/<project>/<runId>`. Before any directory is created, every existing path component from its filesystem root is checked: symbolic links and non-directory ancestors are rejected. They are never reused across projects or runs.
- The clone remote and the checked-out remote must both match the configured GitHub owner/repository.
- A run requires a clean checkout and creates an allowlisted `agent/<runId>` branch from protected `main`; it does not write the caller's current branch.
- Commit and push methods assert the working branch and never use force-push.
- `.env`, key, PEM, credentials/secrets paths and similar protected ignored files are fingerprinted without persisting their contents, so changes invisible to normal `git diff` still fail closed.
- Git control state is fingerprinted independently: configuration, HEAD/control files, refs, reflogs, hooks and `.git/info` are covered while mutable cache/index/object data that can legitimately change during reads is excluded. Temporary ref manipulation that restores the final HEAD is still detectable through reflogs.
- Protected/sensitive changed files are rejected by change policy before any publication path.

## Cross-repository Git credential boundary

Cloud orchestration may receive an optional `AGENT_GITHUB_TOKEN` solely for orchestrator-owned network Git operations against configured private repositories. For configured non-`self` projects, the fixed Git credential helper prefers that token when present and otherwise falls back to the workflow-scoped `GITHUB_TOKEN`; the `self` project deliberately ignores the broader token and keeps using `GITHUB_TOKEN`. Neither secret is embedded in clone/fetch/push arguments, repository URLs, Git config files, prompts, project commands, workflow state, reports, Vercel requests, or GitHub comments.

The credential is translated only into the ephemeral `GH_TOKEN` environment consumed by `gh auth git-credential` for the individual network Git subprocess. Non-network Git receives no GitHub credential environment. The CodingWorker and read-only model executors retain their explicit environment allowlists and never receive `AGENT_GITHUB_TOKEN` or `GITHUB_TOKEN`. Invalid preferred credentials fail closed instead of silently falling back to a different token.

## Commands, budgets, and logs

Install and validation commands come only from `config/projects.json`, reject shell metacharacters, run with `shell: false`, time out, and have output capped. They start from a system-only environment allowlist and may add only literal project variables whose names do not contain `TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `CREDENTIAL`, or `AUTH`; they never inherit orchestration credentials. The worker cannot supply commands or change the execution provider. Active budgets include `maxTasks`, `maxRuntimeMinutes`, `maxModelCalls`, `commandTimeoutMs`, `ciTimeoutMs`, `ciPollIntervalMs`, `deploymentTimeoutMs`, `deploymentPollIntervalMs`, and `maxWorkerAttempts`. `maxModelCalls` is enforced before model invocation on both Orchestrator and WorkflowEngine paths. Each reserved call is persisted with attribution and remains consumed after interruption; missing SDK token usage is recorded as unknown rather than treated as zero-cost evidence.

For a `container-required` project, ordinary post-worker checks run only through Docker with a single workspace bind mount, no network, no HOME/SSH/Git/Codex credentials, no Docker socket, a read-only container root, temporary writable `/tmp`, no added capabilities, `no-new-privileges`, a numeric non-root user, and memory/CPU/PID limits. The sole v0.12 network exception is the governed dependency-refresh stage described above. Docker image inspection is local only and execution passes `--pull never`; the implementation cannot implicitly download an image. A missing daemon or image fails the command rather than executing it on the host. `local-sanitized` is explicitly documented and reported as non-container-isolated; it must never be described as equivalent isolation.

Known GitHub, OpenAI, Vercel, Bearer, and key-like values are redacted before persistence or report output. No token belongs in project configuration, prompts, logs, source files, or commits. `VERCEL_TOKEN` is read only by the deployment adapter and Vercel is queried only with GET requests; deployment, promotion, rollback, domains, and environment settings have no execution path.

## Approvals

Approval and execution are separate. Project configuration may make PR creation approval-required. Merge and production deployment always need approval but have no execution handler in v0.3. Force-pushing main, bypassing approval, disabling security, and protected-branch deletion are forbidden even if a project config requests otherwise.

## Repository controls

The GitHub inspection record reports whether the configured default branch is protected when the API provides that field; `unknown` is reported rather than guessed. This is evidence only: teams should enable GitHub branch protection (required pull-request review and passing status checks) in repository settings. The orchestrator's internal branch policy is not a replacement for GitHub enforcement.
