# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project contract

This repository is a policy-governed engineering orchestrator. Preserve its review-only safety boundary:

- Never merge a pull request.
- Never deploy to production.
- Never weaken branch protection, approval gates, secret boundaries, sandboxing, or least-privilege GitHub permissions.
- Never broaden merge, deployment, production, identity, or credential authority unless a human request explicitly changes that contract.
- Treat every unresolved P1/P2 review finding and every required failing gate as a blocker.
- Prefer fail-closed behavior over silent fallback when authority, identity, state, or evidence cannot be proven.

## Environment

- Use Node.js 24 when available; the package requires Node.js >=22.
- Install the exact locked dependencies with:
  `npm ci --ignore-scripts`
- Do not replace the package manager, regenerate lockfiles, or add dependencies unless the task specifically requires it.
- Setup may use network access only when the environment requires dependency installation. Normal agent work should not assume unrestricted internet access.

## Required validation

For code changes, run the narrowest relevant tests while iterating, then run all applicable repository gates before declaring the work complete:

```bash
npm test
node scripts/browser-qa-chrome-smoke.js
node scripts/browser-qa-adversarial-smoke.js
npm run typecheck
npm run lint
npm run build
```

When Docker is available and the touched path affects the cloud/runtime boundary, also preserve the CI Docker execution boundary. GitHub CI is authoritative for the complete gate.

Do not edit tests merely to hide a real regression. A changed assertion must reflect an intentional, reviewed contract change.

## Change discipline

- Read the current implementation and tests before editing.
- Keep changes tightly scoped to the requested issue/PR.
- If a task names an exact PR HEAD/SHA, verify it before writing and abort rather than overwriting a moved head.
- Preserve exact-SHA, fingerprint, lease, approval, and durable-state bindings.
- Add adversarial regressions for race conditions, crash recovery, stale evidence, ambiguous writes, or privilege-boundary changes.
- Do not silently recover from an uncertain external write if replay could duplicate side effects.
- Do not expose or persist secrets in logs, prompts, commits, comments, state files, or test fixtures.

## Cloud/control-plane changes

For admission, scheduler, queue, Cloud State, or workflow-control changes:

- Keep low-privilege event admission separate from canonical Cloud State authority.
- Canonical state mutation must remain governed and lease-protected where the current protocol requires it.
- Recovery must be idempotent, bounded, crash-safe, and unable to skip human approvals.
- Scheduled recovery must never become an alternate path around approval, CI, publication, merge, or production gates.
- A loop must stop on human wait, terminal/blocking state, no progress, bounded tick/deadline exhaustion, or another explicit fail-closed condition.

## Pull requests

Leave substantial work on a branch/PR for CI and review. Do not merge it yourself. Summaries must distinguish what was implemented, what was verified, and what remains blocked.
