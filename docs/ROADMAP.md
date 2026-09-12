# Roadmap

## v0.1 — complete

Persistent CLI runs, policy/approvals, redaction, JSON state, safe configured commands, deterministic evaluator, mock worker, and read-only GitHub inspection landed in PR #1 and were squash-merged to `main`.

## v0.2 — complete

The first governed engineering vertical slice is implemented: a real Codex SDK worker, protected local Git workflow, authenticated GitHub reads and PR creation, CI polling, deterministic evaluation, bounded correction, and durable resume.

## v0.3 — complete

Registered repositories receive isolated managed workspaces, controlled bootstrap commands, generic acceptance criteria, cross-repository PR/CI flow, and Vercel preview observation through a read-only adapter. The agent remains a CLI: it is not a Vercel deployment target. No automatic merge or production deployment exists.

## v0.4 — complete

Governed real engineering tasks add literal scope input, immutable forbidden-path enforcement, continuous policy evaluation after the worker and every validation command, fingerprint-bound sensitive approvals with stale-approval detection, final commit matching, per-project diff budgets, and a read-only doctor/preflight command. LeadFinder uses the strict 3-file / 200-line policy. The orchestrator still never merges pull requests or deploys production.

## v0.5 — complete

Safe project-command execution adds the provider boundary, a real Docker implementation with no automatic pull, strict `container-required` fail-safe behavior, explicit local fallback only, command-resource limits, a no-network post-worker policy, and doctor evidence for the active isolation contract. It does not create product changes, merge pull requests, or deploy production.

## v0.6 — complete

Deterministic persisted workflow plans add profile-based dependencies, Definition of Done, bounded retries/output/time, managed-workspace reuse, one-time bootstrap, crash-safe resume, and human checkpoints. Active execution budgets pause while waiting for checkpoint approval, workspace preparation is capped by the remaining budget, bootstrap attempts are bounded, and structural placeholders fail closed instead of claiming unimplemented work as complete. The workflow engine still does not execute research, design, implementation, or analysis placeholders; connecting those steps to reviewed executors is deferred to later versions.

## v0.7 — complete

The Tool/Skill Registry makes capability availability explicit and fail-closed. Atomic tools expose reviewed bindings and execution surfaces; skills declare tool dependencies, risk, and versioned input/output contracts. Projects define explicit skill allow/deny policy, with deny taking precedence. Registry and project-policy fingerprints are persisted on runs/workflows so resume cannot silently gain capabilities after configuration changes. Existing Orchestrator actions are gated through the registry, while future research/browser/analysis/inspection capabilities remain registered but unavailable until reviewed executors are added.

The v0.7 scope deliberately does not add browser automation, web research, a new LLM, autonomous specialist agents, or automatic merge/production actions.

## v0.8 — complete

Execution Integration adds persistent execution leases and connects reviewed workflow skills to real executors without bypassing the v0.7 registry. App-improvement supports read-only `code.inspect` / `code.diagnose`, human plan approval, governed workspace-write `code.implement`, and configured verification. Read-only execution is independently checked for workspace mutations; implementation reuses the existing worker and v0.4/v0.5 change governance. Sensitive/forbidden/over-budget/partial/interrupted changes fail or block closed.

## v0.9 — complete

Specialist Agents adds an immutable Specialist Registry, explicit specialist ownership for workflow steps, specialist-registry fingerprinting, authority/risk compatibility checks, persisted specialist evidence, and fail-closed resume on specialist-contract drift. App-improvement now includes an independent read-only Change Critic bound to the exact governed implementation fingerprint. Verification may proceed only after a structurally valid critic `PASS`; critic failure, malformed output, workspace mutation, or stale/replayed review evidence fails closed. Specialist ownership is visible in dry-runs and through `agent specialists`.

## v0.10 — complete

Model Budget Enforcement turns `maxModelCalls` into an actual persisted execution limit across Orchestrator and WorkflowEngine. A model call is reserved before invocation and remains consumed across interruption/crash, preventing retries from silently exceeding the cap. Usage reported by the Codex SDK is normalized into input/output token evidence and attributed by execution surface, skill, workflow step, specialist, and attempt. Registered projects currently cap each run/workflow at six model calls.

v0.10 deliberately does not claim exact monetary spend enforcement: SDK usage may be absent for a call, in which case the call is still counted and marked as missing usage evidence. Token ceilings and price-based budgets remain future hardening work.

v0.10 remains a call-count governor rather than an exact monetary spend cap: SDK usage may still be absent for individual calls.

## v0.10.1 — complete

Interrupted Change Critic recovery is now fail-closed. If a process dies during `code.review`, repository/worktree/control-state changes are checked before any retry can occur; an observed mutation becomes a non-approvable block.

## v0.11 — complete

Reviewed Workflow Publication extends the app-improvement Definition of Done with a controlled review-only publication step. The workflow prepares its managed `agent/<workflowId>` branch before model execution, binds release-readiness approval to the exact reviewed change-set fingerprint, revalidates the unchanged default-branch base, commits the exact governed diff, pushes only the allowlisted review branch, creates and verifies a PR, waits for CI, and observes a required preview when configured.

Publication is encapsulated behind one workflow-only `workflow-publication` authority. Low-level Git/GitHub/Vercel tools remain on the Orchestrator surface. Commit/push/PR phases persist before and after external writes; interrupted external-write state is never replayed automatically. CI/preview observation timeouts may resume without repeating writes. Merge, production deployment, domains, environment variables, secrets, and destructive/data actions remain unavailable to WorkflowEngine.

Browser/research/data-analysis executors remain deferred; v0.13 activates only the offline structured website-planning executor.

### Post-v0.11 audit

A full post-merge review confirmed the publication path is bound to the reviewed change fingerprint, revalidates default-branch drift before commit, before PR creation, and after CI/preview, and exposes no merge or production-deploy method. No open publication defect is known after the review.

Known hardening boundaries remain explicit rather than being treated as solved: Codex workers still rely on the reviewed SDK permission profile under the operator OS account, registered Docker images are currently referenced by mutable tags rather than enforced immutable identities, and exact monetary spend cannot be guaranteed when SDK usage evidence is absent.

## v0.12 — complete

Governed Sensitive & Dependency Changes closes the dependency-change dead end in `app-improvement`. A sensitive implementation now pauses for explicit human approval bound to the exact change-set fingerprint; approval re-measures branch/HEAD/remote, Git control state, protected ignored files, change policy, and the diff before it can complete. A stale or mutated workspace cannot reuse the approval and the coding worker is not rerun merely because approval was requested.

If the approved diff changes a package manifest or lockfile, the deterministic `dependency-refresh` stage must complete before Change Critic. It never accepts a model-generated install command: configuration is limited to the exact frozen no-lifecycle-script npm/pnpm command, requires `container-required`, and enables network only for that stage. The workspace snapshot must be unchanged after the refresh and completion evidence must attest the real Docker provider/stage/network boundary. Package-manager control files such as `.npmrc`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, and Yarn rc files are immutable/protected so the worker cannot redirect the networked resolver. Nested workspace manifests and lockfiles are governed too.

Projects without a reviewed lockfile/refresh command fail closed rather than improvising dependency installation. Normal changes execute a deterministic no-op dependency stage and gain no network authority. Merge and production deployment remain unavailable.

## v0.13 — complete

Structured Website Build turns the previously structural `website-build` profile into a governed executable path for explicitly registered website repositories. The workflow accepts a strict local business brief through a bounded stable file-handle read, fingerprints it, verifies and hashes declared repository-local assets through stable validated handles, and invokes an offline read-only `website.plan` specialist. The planner has a strict output schema and anti-fabrication contract; its SEO primary location must come from the supplied business locations. Design approval is bound to the exact plan fingerprint. The coding worker revalidates brief/plan/approval/assets, treats supplied business data as untrusted context, and must not invent unsupported claims; assets are checked again after the worker.

After implementation, website builds reuse the v0.12 dependency-refresh boundary and an independent Change Critic that receives the authoritative brief/plan/asset evidence and must review the exact current diff. All four deterministic quality commands—test, typecheck, lint, build—are mandatory. A fingerprint-bound release-readiness checkpoint permits v0.11 review publication; successful CI and a usable READY non-production preview for the exact commit are mandatory for website builds. The human visual checkpoint comes last and is bound to the reviewed change-set fingerprint, published commit SHA, and exact preview URL. A normal happy path uses three model calls: website planner, implementer, and critic.

This version intentionally does **not** add web research, browser/computer-use visual inspection, Lighthouse automation, automatic merge, production deployment, domains, environment-variable mutation, or secret writes. It is a governed website factory core, not yet the final hands-off website factory.

## v0.14 — complete

Supervised Issue Queue makes the local agent operable from a narrow GitHub control channel without moving Codex authentication into GitHub Actions. A strict allowlisted `app-improvement` issue produces a zero-write dry-run first. Exact GitHub approval comments are fingerprint-bound to the request/dry-run and to every later WorkflowEngine checkpoint. Remote requests require explicit bounded allowed paths.

The queue is crash/concurrency aware: new issues are atomically reserved, abandoned initialization blocks, existing workflows retain execution leases, issue edits/stale approvals fail closed, deterministic initialization failures are not retried forever, and transient GitHub errors do not kill the watcher. Read-only CI/preview observation timeouts can resume under the existing publication rules; commit/push/PR uncertainty cannot be replayed. The queue exposes no merge or production capability.

This creates the operational path for the first genuine Callflow dogfood: the agent—not ChatGPT/manual edits—should inspect, plan, implement, independently critique, verify and publish one bounded Callflow improvement under supervision. Automatic browser QA, unattended merge/production, parallel remote workers and broader request profiles remain deferred.

## Deferred

Project-specific business evaluators, richer worker-level thread resume, webhooks, dashboards, parallel workers, cloud state, and production integrations are deferred. Later work should connect reviewed placeholder executors through these capability contracts rather than bypassing the registry.
