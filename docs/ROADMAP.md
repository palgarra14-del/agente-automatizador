# Roadmap

## v0.1 — complete

Persistent CLI runs, policy/approvals, redaction, JSON state, safe configured commands, deterministic evaluator, mock worker, and read-only GitHub inspection landed in PR #1 and were squash-merged to `main`.

## v0.2 — complete

The first governed engineering vertical slice is implemented: a real Codex SDK worker, protected local Git workflow, authenticated GitHub reads and PR creation, CI polling, deterministic evaluation, bounded correction, and durable resume.

## v0.3 — complete

Registered repositories receive isolated managed workspaces, controlled bootstrap commands, generic acceptance criteria, cross-repository PR/CI flow, and Vercel preview observation through a read-only adapter. The agent remains a CLI: it is not a Vercel deployment target. No automatic merge or production deployment exists.

## v0.4 — current

Governed real engineering tasks add literal scope input, immutable forbidden-path enforcement, continuous policy evaluation after the worker and every validation command, fingerprint-bound sensitive approvals with stale-approval detection, final commit matching, per-project diff budgets, and a read-only doctor/preflight command. LeadFinder uses the strict 3-file / 200-line policy. The orchestrator still never merges pull requests or deploys production.

## Deferred

Project-specific business evaluators, richer worker-level thread resume, webhooks, dashboards, parallel workers, cloud state, and production integrations are deferred. Do not start v0.5 from this branch.
