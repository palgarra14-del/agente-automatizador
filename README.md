# Engineering Orchestrator — v0.11.1

A CLI-first, policy-governed engineering loop for registered repositories. It turns a small engineering objective into a reviewable pull request; it never merges a pull request or deploys production.

## What is real

- A deterministic planner creates a structured coding task.
- The official Codex SDK runs a local coding worker in `workspace-write`, with network access disabled.
- Each run gets an isolated managed workspace under `.agent-workspaces/<project>/<runId>`; its controlled clone, remote, base SHA, branch, install, checks, and Git evidence are persisted.
- The orchestrator creates an allowlisted `agent/<runId>` branch, controls the configured install/checks, commits, pushes, opens a GitHub pull request, polls CI, and can observe a matching Vercel preview through its read-only API.
- Run state, audit events, CI/preview observations, branch/commit/PR facts, and retry state are persisted in `.agent/state.json`.
- GitHub calls use `GITHUB_TOKEN`; local Git uses the checkout's configured credential mechanism.

## Quick start

Requires Node 22+, an already authenticated local Codex installation, `GITHUB_TOKEN` with repository and pull-request permissions, and a clean checkout. Projects are configured as `container-required` and also require a locally available Docker daemon plus the configured image; the orchestrator never pulls an image automatically. Projects that require preview observation additionally need `VERCEL_TOKEN` only in the orchestrator process. This implementation deliberately injects neither token nor `CODEX_API_KEY` into the worker environment. Before creating its branch, it fetches `origin/main` and verifies that exact SHA against GitHub.

Prepare LeadFinder's declared local toolchain explicitly before any real run; the Agent itself does not build it:

```bash
docker build --pull=false --tag agent-node22-pnpm11:local docker/node22-pnpm11
```

```bash
npm ci
node src/cli.js run --project self --goal "Update a controlled documentation fixture with one accurate sentence"
node src/cli.js doctor --project leadfinder
node src/cli.js run --project leadfinder --goal "Fix one small empty state" --allowed-path app --forbidden-path package.json --forbidden-path pnpm-lock.yaml --dry-run
node src/cli.js report <runId>
node src/cli.js resume <runId>
```

Add `--dry-run` to persist the plan and a zero-write simulation. It does not create a workspace or clone, create or switch branches, invoke the worker or checks, commit, push, create a PR, query Vercel, or write to GitHub. The dry-run now also records the required capability plan and reports any unavailable skill without pretending it is executable.

## Capabilities, workflows, and plans

v0.7 adds a deterministic Tool/Skill Registry on top of the v0.6 workflow engine. Tools are atomic bound integrations; skills are higher-level capabilities with versioned input/output contracts, declared tool dependencies, allowed execution surfaces, and risk metadata. The registry and each project's normalized skill policy receive SHA-256 fingerprints. Runs and workflows persist both fingerprints and fail closed if either contract changes before resume.

Inspect the effective capability surface for a project with:

```bash
node src/cli.js capabilities --project leadfinder --surface workflow
node src/cli.js capabilities --project leadfinder --surface orchestrator
```

`config/projects.json` contains an explicit `skills.allow` / `skills.deny` policy. `deny` takes precedence over `allow`. Runs/workflows created before v0.7 do not have capability fingerprints and are intentionally not auto-migrated; they fail closed and should be recreated under the current registry. Existing v0.6 capabilities are registered and enforced in the Orchestrator: workspace preparation, bootstrap, project verification, coding, repository publication, PR creation, CI observation, preview observation, and human approval. `code.inspect` and `code.diagnose` have reviewed workflow-only read-only executors, `code.implement` has a governed workspace-write executor, and `code.review` provides an independent read-only Change Critic. Future skills such as `research.web`, `visual.review`, data analysis, and website requirements definition remain unavailable until reviewed executors exist.

v0.8 added persisted per-run/per-workflow execution leases and the first reviewed workflow executors. v0.9 added explicit specialists plus an independent Change Critic. v0.10 added a real persisted model-call budget, currently six calls per registered project run/workflow. v0.11 extends `app-improvement` through a review-only publication boundary: after implementation, critic PASS, configured verification, and explicit release-readiness approval, the workflow can commit the exact governed diff, push its allowlisted `agent/<workflowId>` branch, create and verify a PR, wait for complete GitHub CI evidence, and observe a matching Vercel preview when configured. Merge and production deployment remain unavailable.

v0.6 added deterministic, persisted workflow plans. A workflow associates a registered project and goal with a profile, ordered dependency steps, bounded retries/budget, evidence, human checkpoints, and a Definition of Done. It does not yet use an LLM, browser, web research, or external executor.

```bash
node src/cli.js workflow create app-improvement --project self --goal "Improve one bounded behavior" --allowed-path src
node src/cli.js workflow run <workflowId> --dry-run
node src/cli.js workflow status <workflowId>
node src/cli.js workflow run <workflowId>
node src/cli.js workflow approve <workflowId> plan-change
node src/cli.js workflow resume <workflowId>
node src/cli.js workflow list
```

The available profiles are `website-build`, `app-improvement`, and `data-analysis`. Verification steps use profile-specific subsets of the registered command allowlist rather than rerunning every check at every verification point. For a managed project, the workflow prepares one project-and-workflow-specific managed workspace and persists its repository/workspace evidence for safe reuse on resume. A recovered workspace is reused only when it is a clean checkout of the configured repository on the configured base branch; an incomplete or mismatched clone is retained under a `.failed-*` sibling and replaced by a fresh controlled clone. If that registered project has an allowlisted `install` command, the clean managed workspace bootstraps it once through the existing bootstrap execution stage before its first verification command. Successful bootstrap evidence is bound to that workspace and is reused on resume; interrupted bootstrap is never assumed successful. Persisted workflow state is fail-closed: profile shape, command names, workspace allocation, bootstrap evidence, budgets, dependencies, pause state, and Definition of Done must still match the registered project before a command can run. Workflow steps persist their exact skill id. Before execution, the active registry resolves project policy, surface, required tools, and binding availability. A missing/forbidden/unbound skill blocks fail-closed with explicit capability evidence; structural placeholders never claim completion without an executor. Only real checkpoints and crash-interrupted executable steps can accept human approval.

The workflow timeout is an active-execution budget, not a per-command allowance: it is checked before workspace preparation, each step, retry, bootstrap, and command, and command/clone timeouts are capped to the time remaining. Human checkpoint wait time is paused and added back when the checkpoint is approved. Unimplemented placeholder skills remain structural and fail closed through the capability registry. Implemented app-improvement skills require executor evidence bound to the active capability context; `code.implement` additionally requires a normal governed change-set fingerprint before it can complete. Definition of Done is strict: only a `completed` required step satisfies it; `skipped` never does. An app-improvement dry run remains non-mutating for the project: it does not prepare/clone a workspace, invoke Codex, execute commands, commit, push, create a PR, or query a preview. It reports the complete deterministic step graph, specialist authority, capability resolution, planned bootstrap, and any planned external-write publication step.

The project commands, protected branches, branch pattern, approvals, capability policy, change policy, execution provider, and budgets live in `config/projects.json`. `agent doctor --project <id>` reports GitHub connectivity, Codex SDK availability, the configured workspace and commands, Vercel configuration/token presence, branch protection, and execution isolation availability without printing credentials. Use `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` for local validation.

## Guarantees and boundaries

- Only registered projects can run. A managed workspace validates its containment, rejects symlinked workspace paths, clones the configured origin only, and validates that origin again before work starts.
- `main` is protected in project configuration; a run works only on a new `agent/<runId>` branch created from the SHA shared by GitHub and `origin/main`.
- The worker receives a redacted structured task, never GitHub/OpenAI credentials, and cannot choose commits, pushes, PRs, merge, deployment, or validation commands.
- The orchestrator runs only configured commands without a shell. It refuses path traversal, protected files such as `.env`, working branches outside the allowlist, protected-branch pushes, and changes to Git history made by the worker.
- v0.4 evaluates the actual diff after the worker, after every configured command, and immediately before commit. `.env` variants, PEM/key files, secret/credential paths, `.git`, and workspace escapes fail. Project budgets default to 8 files / 500 diff lines (LeadFinder: 3 / 200). Package manifests and lockfiles, workflows, scripts, deployment configuration, Dockerfiles, and security/auth-sensitive diffs require a recorded approval before those actions proceed. That approval is bound to a SHA-256 change-set fingerprint; an altered diff becomes stale and needs fresh approval, and the commit must match the final governed fingerprint.
- v0.5 makes post-worker commands an execution-provider concern. The registered projects use `container-required`: the Docker image must already exist locally or the run fails before executing a check. Docker is invoked with `--pull never`, so it cannot download an image as a fallback. Post-worker containers receive a writable workspace bind mount and only its nested `.git` metadata as a read-only bind mount; no HOME/SSH/external-Git/Codex credential mounts, Docker socket, or privileged mode are allowed. The root filesystem is read-only; `/tmp` is a writable tmpfs; the command has dropped Linux capabilities, `no-new-privileges`, a non-root user, resource limits, timeouts, and `--network none`. Commit and push each revalidate branch, HEAD, repository identity, and the exact configured GitHub origin; commit uses `--no-verify`. LeadFinder declares the prepared local `agent-node22-pnpm11:local` image with `pnpm 11.19.0`; the image is not operationally verified where Docker is unavailable. A pre-worker `install` may use its default container network; it is never rerun automatically after the worker alters package metadata.
- Scope input is deliberately simple: repeat `--allowed-path <relative-root>` and `--forbidden-path <relative-root>` as needed. They are literal repository-relative roots, not a task DSL; the orchestrator independently verifies the resulting paths after the worker finishes.
- `create_branch`, commit, and push are safe operations. A project can require approval for PR creation. Merge and production deploy are approval-required but deliberately have no execution handler. Force-push to `main` and protected-branch deletion are forbidden.
- CI ends as `pending`, `success`, `failure`, or `timeout`. GitHub Check Runs and commit status contexts are both evaluated, paginated with a bounded fail-closed limit, and only the latest status per context is authoritative. A configured Vercel provider only observes preview deployments and treats `READY`, `ERROR`, `NOT_FOUND`, `TIMEOUT`, and `NOT_CONFIGURED` explicitly. There is no automatic merge.

The agent itself is a CLI and is not hosted on Vercel. See [architecture](docs/ARCHITECTURE.md), [safe command execution](docs/V0.5-SAFE-COMMAND-EXECUTION.md), [cross-repository workspaces](docs/CROSS_REPO.md), [Vercel observation](docs/VERCEL_INTEGRATION.md), and [security](docs/SECURITY.md) for implementation detail.
