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

## v0.10 — current

Model Budget Enforcement turns `maxModelCalls` into an actual persisted execution limit across Orchestrator and WorkflowEngine. A model call is reserved before invocation and remains consumed across interruption/crash, preventing retries from silently exceeding the cap. Usage reported by the Codex SDK is normalized into input/output token evidence and attributed by execution surface, skill, workflow step, specialist, and attempt. Registered projects currently cap each run/workflow at six model calls.

v0.10 deliberately does not claim exact monetary spend enforcement: SDK usage may be absent for a call, in which case the call is still counted and marked as missing usage evidence. Token ceilings and price-based budgets remain future hardening work.

WorkflowEngine still cannot commit, push, open PRs, merge, browse the web, or deploy. Browser/research/data-analysis executors remain deferred.

## Deferred

Project-specific business evaluators, richer worker-level thread resume, webhooks, dashboards, parallel workers, cloud state, and production integrations are deferred. Later work should connect reviewed placeholder executors through these capability contracts rather than bypassing the registry.
