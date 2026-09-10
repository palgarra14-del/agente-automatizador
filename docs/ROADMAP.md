# Roadmap

## v0.1 — complete

Persistent CLI runs, policy/approvals, redaction, JSON state, safe configured commands, deterministic evaluator, mock worker, and read-only GitHub inspection landed in PR #1 and were squash-merged to `main`.

## v0.2 — current

The first governed engineering vertical slice is implemented: a real Codex SDK worker, protected local Git workflow, authenticated GitHub reads and PR creation, CI polling, deterministic evaluation, bounded correction, and durable resume. Vercel is not implemented; it is intentionally not allowed to deploy.

## Deferred

Project-specific evaluators, Vercel read-only discovery, richer worker-level thread resume, webhooks, dashboards, parallel workers, cloud state, and production integrations are out of scope. Do not start v0.3 from this branch.
