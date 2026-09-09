# Engineering Orchestrator — v0.2

A CLI-first, policy-governed engineering loop for configured repositories. It turns a small engineering objective into a reviewable pull request; it never merges a pull request or deploys production.

## What is real

- A deterministic planner creates a structured coding task.
- The official Codex SDK runs a local coding worker in `workspace-write`, with network access disabled.
- The orchestrator creates an allowlisted `agent/<runId>` branch, controls the configured checks, commits, pushes, opens a GitHub pull request, and polls CI.
- Run state, audit events, CI observations, branch/commit/PR facts, and retry state are persisted in `.agent/state.json`.
- GitHub calls use `GITHUB_TOKEN`; local Git uses the checkout's configured credential mechanism.

## Quick start

Requires Node 22+, an authenticated Codex installation (or `CODEX_API_KEY` for the SDK), `GITHUB_TOKEN` with repository and pull-request permissions, and a clean checkout. The generated branch is always created from configured `main`; the caller's current branch is never written directly.

```bash
npm ci
node src/cli.js run --project self --goal "Update a controlled documentation fixture with one accurate sentence"
node src/cli.js report <runId>
node src/cli.js resume <runId>
```

The project commands, protected branches, branch pattern, approvals, and budgets live in `config/projects.json`. Use `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` for local validation.

## Guarantees and boundaries

- `main` is protected in project configuration; a run requires a clean checkout and works only on a new `agent/<runId>` branch created from `main`.
- The worker receives a redacted structured task, never GitHub/OpenAI credentials, and cannot choose commits, pushes, PRs, merge, deployment, or validation commands.
- The orchestrator runs only configured commands without a shell. It refuses path traversal, protected files such as `.env`, working branches outside the allowlist, protected-branch pushes, and changes to Git history made by the worker.
- `create_branch`, commit, and push are safe operations. A project can require approval for PR creation. Merge and production deploy are approval-required but deliberately have no execution handler. Force-push to `main` and protected-branch deletion are forbidden.
- CI ends as `pending`, `success`, `failure`, or `timeout`; failed checks can cause at most `maxWorkerAttempts` worker attempts. There is no automatic merge.

See [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), [Codex integration](docs/CODEX_INTEGRATION.md), and the [real smoke-test record](docs/V0.2-SMOKE-TEST.md) for implementation detail.
