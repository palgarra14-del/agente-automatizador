# Operating Model — canonical methodology

This file is the short operational contract for the engineering orchestrator. When older docs, issues, branches, comments or historical state disagree with it, the current validated configuration and this methodology win.

## Sources of truth, in order

1. **Operator instruction** for the current task, within existing safety/governance boundaries.
2. **`config/projects.json` shared `businessContext`** for the commercial model, offer, priorities, metrics and constraints.
3. **Per-project configuration** in `config/projects.json` for repository, scope, commands, budgets, skills and project role.
4. **Current Cloud State + repository/CI evidence** for operational truth.
5. **This document + architecture/security docs** for methodology.
6. Issues, PR descriptions and historical docs are backlog/evidence, not authority when stale.

The obsolete €490 + €149/month offer must never be revived from historical material. Current prices are “from” values and scope is confirmed per project.

## Commercial machine

`LeadFinder -> Callflow -> diagnosis -> demo when appropriate -> close -> Website Pilot -> delivery -> feedback -> learning`

The purpose is not software output. The purpose is more qualified conversations and sales with less human time, less wasted calling, less rework and higher operational reliability.

### LeadFinder

Find real, active, contactable local businesses with a verifiable commercial reason to call. Keep business strength, digital need, contactability, commercial fit, confidence and priority explainable. Quality beats raw volume.

### Callflow

Make “who do I call now?” and call -> result -> next nearly instant. Keep uninterested/lost outcomes in history. Prioritize callbacks, demos, proposals and close actions when evidence says they matter. Never auto-send external communications.

### Website Pilot

Verified brief -> design -> implementation -> technical/visual QA -> critique -> correction -> usable demo/site. Mobile quality, clear locality/service, contact/booking CTAs, existing booking integrations and factual honesty are mandatory. Protect package scope.

### Self

Self-improvement is spare-capacity work unless infrastructure is blocking business. It must not outrank runnable commercial work.

## Work states

Use these meanings consistently:

- **Proposed**: idea/backlog only.
- **Queued**: accepted and waiting for capacity/gate.
- **Running**: a workflow has a current execution lease and is advancing a real step.
- **Waiting approval**: blocked on an explicit human gate/fingerprint.
- **Blocked**: cannot advance safely; reason is persisted.
- **Completed**: Definition of Done for that workflow is satisfied.
- **Superseded**: replaced by a newer canonical request/PR and should not compete for ranking.

A service being `active (running)` does **not** mean the business lane is producing. Operational health and productive work are separate signals.

## Selection and autoranking

At every dispatch boundary:

1. Explicit operator work outranks autonomous work.
2. Runnable business work outranks self-improvement.
3. Rank by evidence-backed impact: sales blocker -> wasted-call reduction -> call-to-demo/demo-to-sale -> human-time reduction -> reliability blocker -> missing measurement.
4. Choose one bounded unit per lane; avoid duplicate PRs/issues/workflows.
5. Terminal outcomes update ranking memory before the next iteration.
6. Small samples do not justify aggressive score/weight changes.

Do not spend a business lane on infrastructure-only work when it can be surfaced to `self` instead.

## WIP discipline

- Reuse an existing safe branch/PR when it already contains equivalent work.
- One active autonomous workflow per lane.
- Do not retry terminal requests blindly; create a deliberate successor only when the old request cannot be resumed.
- Close or mark superseded backlog that is demonstrably implemented or replaced.
- Historical workspaces are evidence, not mutable runtime. Never follow or trust stale symlinked managed workspaces.
- New managed workspaces must be physical, isolated directories tied to project + workflow.

Autonomous filler caps:
- `self`: 6 starts / rolling 24h.
- each business lane: 12 starts / rolling 24h.

## Model/resource policy

- Codex subscription is the primary high-value implementation resource.
- Paid API fallback is disabled. No new paid API/service is introduced without explicit authorization.
- Keep a default 20% Codex subscription reserve when quota telemetry is known; an explicit override is required to consume the reserve.
- OpenCode hosted-free models are specialized by measured task performance.
- Ollama stays cold and is used only when locality/offline execution materially matters; it must not become the normal bulk fallback.
- Deterministic tests, repository evidence and QA outrank model confidence.
- Provider capacity timeouts receive short cooldowns; do not disable an otherwise healthy provider for a long period because one slot was busy.

## Workflow methodology

For governed code work:

`workspace -> inspect -> diagnose -> plan/gate when required -> implement -> independent review -> tests/checks -> verification -> PR/preview -> human release gate`

Rules:
- Work from authoritative base revision.
- Scope and forbidden paths are explicit.
- Implementation and review must stay bound to the same historical workspace evidence; mismatches fail closed and replan.
- A model failure must use safe fallback/retry budgets, not infinite retry.
- Merge, production deployment, destructive changes, secrets and external communications remain explicit gates.
- Vercel preview readiness is evidence; it is not production authorization.

## Runtime and cloud

There must be one canonical operator revision. Local MSI runtime, Cloud Workers and Control Center should converge on it.

Temporary hotfix operation may run a validated detached SHA, but that is a transition state. Do not let `main`, local runtime and cloud logic diverge indefinitely.

Night Mode is operator-controlled. It may improve unattended continuity, but it never changes merge/deploy/communication authority.

## Definition of “clean base”

The system is ready for further expansion when:

- commercial source of truth is singular and current;
- active runtime and cloud use the same validated revision;
- obsolete/superseded PRs and issues no longer compete with current ranking;
- each lane has explicit scope, budgets and measurable purpose;
- no duplicate workers/workspaces are active;
- CI is green for the canonical consolidation PR;
- merge and production remain independently controlled.
