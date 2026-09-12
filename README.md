# Engineering Orchestrator — v0.14

A CLI-first, policy-governed engineering loop for registered repositories. It turns a small engineering objective into a reviewable pull request; it never merges a pull request or deploys production.

## What is real

- A deterministic planner creates a structured coding task.
- The official Codex SDK runs a local coding worker in `workspace-write`, with network access disabled.
- Each run gets an isolated managed workspace under `.agent-workspaces/<project>/<runId>`; its controlled clone, remote, base SHA, branch, install, checks, and Git evidence are persisted.
- The orchestrator creates an allowlisted `agent/<runId>` branch, controls the configured install/checks, commits, pushes, opens a GitHub pull request, polls CI, and can observe a matching Vercel preview through its read-only API.
- Run state, audit events, CI/preview observations, branch/commit/PR facts, and retry state are persisted in `.agent/state.json`.
- GitHub calls use `GITHUB_TOKEN`; local Git uses the checkout's configured credential mechanism.

## Quick start

Requires Node 22+, an already authenticated local Codex installation, `GITHUB_TOKEN` with repository and pull-request permissions, and a clean checkout. The governed Codex worker is supported only on verified Linux/macOS isolation paths; on a Windows host, run the agent inside WSL/Linux. Native Windows execution fails closed instead of weakening filesystem isolation. Projects are configured as `container-required` and also require a locally available Docker daemon plus the configured image; the orchestrator never pulls an image automatically. Projects that require preview observation additionally need `VERCEL_TOKEN` only in the orchestrator process. This implementation deliberately injects neither token nor `CODEX_API_KEY` into the worker environment. Before creating its branch, it fetches `origin/main` and verifies that exact SHA against GitHub.

v0.14 also supports a supervised GitHub-issue inbox. GitHub is only the control/approval channel; the agent process and Codex authentication stay local. Start with `agent inbox once` while validating the setup, then `agent inbox watch` for a persistent operator.

Read-only `code.inspect`, `code.diagnose`, and `code.review` on explicitly scoped workflows now receive a bounded repository context prepared by the orchestrator itself: only Git-tracked/untracked non-ignored files inside `scope.allowedPaths`, with forbidden/secret-control paths rejected, per-file and total byte limits, SHA-256 evidence, secret masking before prompt construction, and a post-analysis fingerprint recheck. When that context is present, the specialist is instructed not to discover/read repository files through shell or filesystem tools, and returned paths must refer only to supplied files. The Codex filesystem sandbox remains defense in depth rather than the sole source of repository grounding.

```bash
node src/cli.js inbox once
node src/cli.js inbox status
# after validation:
node src/cli.js inbox watch
```

Issue requests use the exact `<!-- agent-request:v1 -->` marker followed by strict JSON. v0.14 accepts only `app-improvement`, requires at least one explicit bounded `scope.allowedPaths` entry, and never treats an issue as authorization to execute. The first action is always a zero-write workflow dry-run. Real execution requires an exact allowlisted GitHub comment `/agent approve <fingerprint>`; every later WorkflowEngine checkpoint/sensitive approval receives a new state-bound fingerprint.

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

`config/projects.json` contains an explicit `skills.allow` / `skills.deny` policy. `deny` takes precedence over `allow`. Runs/workflows created before v0.7 do not have capability fingerprints and are intentionally not auto-migrated; they fail closed and should be recreated under the current registry. Existing v0.6 capabilities are registered and enforced in the Orchestrator: workspace preparation, bootstrap, project verification, coding, repository publication, PR creation, CI observation, preview observation, and human approval. `code.inspect` and `code.diagnose` have reviewed workflow-only read-only executors, `code.implement` has a governed workspace-write executor, and `code.review` provides an independent read-only Change Critic. v0.13 also binds `website.plan` to the read-only requirements specialist for registered website projects. Web research, automatic browser/visual review, and data-analysis model executors remain unavailable until separately reviewed.

v0.8 added persisted per-run/per-workflow execution leases and the first reviewed workflow executors. v0.9 added explicit specialists plus an independent Change Critic. v0.10 added a real persisted model-call budget, currently six calls per registered project run/workflow. v0.11 added review-only PR/CI/preview publication. v0.12 added fingerprint-bound sensitive approval and governed frozen dependency refresh. v0.13 turns `website-build` into an executable structured website workflow: a bounded local business brief and stable verified repository assets feed an offline read-only planner; a human approves the exact design plan; Codex implements it under the existing write governance; dependency changes, an independent factual/technical Change Critic, and mandatory test/typecheck/lint/build follow. A fingerprint-bound release checkpoint then permits review-only publication, CI must succeed, a usable Vercel preview must be READY for the exact commit, and only then can the human visual checkpoint approve that exact preview URL/commit. The normal happy path uses three model calls: planner, implementer, critic. Merge and production deployment remain unavailable.

v0.6 introduced deterministic persisted workflow plans; later versions connected selected steps to reviewed model and external executors. A workflow associates a registered project and goal with a profile, ordered dependency steps, bounded retries/budget, evidence, human checkpoints, and a strict Definition of Done. Browser automation and web research are still not part of WorkflowEngine.

```bash
node src/cli.js workflow create website-build --project <registered-site> --goal "Create a professional site" --brief business.json
node src/cli.js workflow create app-improvement --project self --goal "Improve one bounded behavior" --allowed-path src
node src/cli.js workflow run <workflowId> --dry-run
node src/cli.js workflow status <workflowId>
node src/cli.js workflow run <workflowId>
node src/cli.js workflow approve <workflowId> plan-change
node src/cli.js workflow resume <workflowId>
node src/cli.js workflow list
```

The available profiles are `website-build`, `app-improvement`, and `data-analysis`. `website-build` requires `--brief <business-brief.json>` and runs only on a registered project whose explicit skill policy authorizes the website capabilities. Verification steps use profile-specific subsets of the registered command allowlist rather than rerunning every check at every verification point. For a managed project, the workflow prepares one project-and-workflow-specific managed workspace and persists its repository/workspace evidence for safe reuse on resume. A recovered workspace is reused only when it is a clean checkout of the configured repository on the configured base branch; an incomplete or mismatched clone is retained under a `.failed-*` sibling and replaced by a fresh controlled clone. If that registered project has an allowlisted `install` command, the clean managed workspace bootstraps it once through the existing bootstrap execution stage before its first verification command. Successful bootstrap evidence is bound to that workspace and is reused on resume; interrupted bootstrap is never assumed successful. Persisted workflow state is fail-closed: profile shape, command names, workspace allocation, bootstrap evidence, budgets, dependencies, pause state, and Definition of Done must still match the registered project before a command can run. Workflow steps persist their exact skill id. Before execution, the active registry resolves project policy, surface, required tools, and binding availability. A missing/forbidden/unbound skill blocks fail-closed with explicit capability evidence; structural placeholders never claim completion without an executor. Only real checkpoints and crash-interrupted executable steps can accept human approval.

The workflow timeout is an active-execution budget, not a per-command allowance: it is checked before workspace preparation, each step, retry, bootstrap, and command, and command/clone timeouts are capped to the time remaining. Human checkpoint wait time is paused and added back when the checkpoint is approved. Unimplemented placeholder skills remain structural and fail closed through the capability registry. Implemented governed-write profiles (`app-improvement` and `website-build`) require executor evidence bound to the active capability context; `code.implement` requires either a normal governed change-set fingerprint or a sensitive fingerprint with an explicit, freshly revalidated human approval. Dependency metadata changes must then pass the governed `dependency-refresh` stage before the independent critic can run. Definition of Done is strict: only a `completed` required step satisfies it; `skipped` never does. An app-improvement or website-build dry run remains non-mutating for the project: it does not prepare/clone a workspace, invoke Codex, execute commands, commit, push, create a PR, or query a preview. It reports the complete deterministic step graph, specialist authority, capability resolution, planned bootstrap, and any planned external-write publication step.

The project commands, protected branches, branch pattern, approvals, capability policy, change policy, execution provider, and budgets live in `config/projects.json`. `agent doctor --project <id>` reports GitHub connectivity, Codex SDK availability, the configured workspace and commands, Vercel configuration/token presence, branch protection, and execution isolation availability without printing credentials. Use `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` for local validation.

## Structured website-build boundary

A website brief is local JSON only, bounded to 64 KiB at the CLI and normalized into an exact versioned schema. Unknown fields, path escapes, malformed colors, and unbounded lists are rejected. Declared logo/photo paths must already exist inside the managed workspace as regular non-symlink files; they are size-bounded, SHA-256 fingerprinted before planning, and revalidated before implementation. The planner is offline/read-only and is instructed not to invent testimonials, awards, credentials, prices, guarantees, service areas, clients, or other unsupported business facts. Unsupported facts belong in `missingInputs`; the SEO primary location is deterministically restricted to locations supplied by the brief.

Design approval binds to the exact website-plan fingerprint. Implementation binds to the brief, plan, approval, and asset fingerprint, then reuses v0.12 sensitive/dependency governance. Business-specific claims are constrained at planner, implementer, and independent critic boundaries; supplied context is treated as untrusted data rather than authority. Declared assets are hashed through stable validated file handles and are revalidated after Codex. Deterministic quality requires all four configured commands: test, typecheck, lint, and build. Release-readiness approval permits review publication; CI and an exact READY non-production preview with URL must then exist before the human visual checkpoint can approve that commit/URL. v0.13 deliberately does **not** claim browser-based visual QA, Lighthouse automation, web research, automatic merge, or production deployment.

## Supervised issue-queue boundary

v0.14 adds a local operator loop for dogfooding the agent against projects such as Callflow without manually implementing the target change. The queue polls one configured private GitHub repository, accepts requests only from explicit allowlisted actors, normalizes and fingerprints the issue body, creates the normal WorkflowEngine plan, and posts a dry-run summary. GitHub comments are approval evidence; local queue state alone cannot authorize a pristine workflow.

The queue is deliberately serial and fail-closed. New issues are atomically reserved before workflow creation so two watchers cannot create duplicate workflows. Interrupted initialization blocks instead of retrying invisibly. Issue edits invalidate the accepted request fingerprint. Approval comments must consist exactly of `/agent approve <64-hex>` or `/agent reject <64-hex>`. A stale workflow/checkpoint fingerprint is rejected. Existing WorkflowEngine execution leases remain authoritative once a workflow exists. CI/preview observation timeouts may resume because those phases are read-only; uncertain commit/push/PR phases retain the existing non-replay rule.

The queue does not add a merge handler, production deployment, secret writes, arbitrary commands, web research, or extra Codex authority. `GITHUB_TOKEN` remains in the local orchestrator/issue-channel process and is excluded from Codex worker environments. The first Callflow dogfood should therefore be: structured issue → dry-run review → fingerprint approval → agent-owned implementation/review/tests/PR/preview, with no manual Callflow edit used as a substitute.

## Guarantees and boundaries

- Only registered projects can run. A managed workspace validates its containment, rejects symlinked workspace paths, clones the configured origin only, and validates that origin again before work starts.
- `main` is protected in project configuration; a run works only on a new `agent/<runId>` branch created from the SHA shared by GitHub and `origin/main`.
- The worker receives a redacted structured task, never GitHub/OpenAI credentials, and cannot choose commits, pushes, PRs, merge, deployment, or validation commands.
- The orchestrator runs only configured commands without a shell. It refuses path traversal, protected files such as `.env`, working branches outside the allowlist, protected-branch pushes, and changes to Git history made by the worker.
- v0.4 evaluates the actual diff after the worker, after every configured command, and immediately before commit. `.env` variants, PEM/key files, secret/credential paths, `.git`, and workspace escapes fail. Project budgets default to 8 files / 500 diff lines (LeadFinder: 3 / 200). Package manifests and lockfiles, workflows, scripts, deployment configuration, Dockerfiles, and security/auth-sensitive diffs require a recorded approval before those actions proceed. That approval is bound to a SHA-256 change-set fingerprint; an altered diff becomes stale and needs fresh approval, and the commit must match the final governed fingerprint.
- v0.5 makes post-worker commands an execution-provider concern. The registered projects use `container-required`: the Docker image must already exist locally or the run fails before executing a check. Docker is invoked with `--pull never`, so it cannot download an image as a fallback. Post-worker containers receive a writable workspace bind mount and only its nested `.git` metadata as a read-only bind mount; no HOME/SSH/external-Git/Codex credential mounts, Docker socket, or privileged mode are allowed. The root filesystem is read-only; `/tmp` is a writable tmpfs; the command has dropped Linux capabilities, `no-new-privileges`, a non-root user, resource limits, timeouts, and `--network none`. Commit and push each revalidate branch, HEAD, repository identity, and the exact configured GitHub origin; commit uses `--no-verify`. LeadFinder declares the prepared local `agent-node22-pnpm11:local` image with `pnpm 11.19.0`; the image is not operationally verified where Docker is unavailable. A pre-worker `install` may use its default container network. v0.12 adds one separate post-worker exception: the dedicated `dependency-refresh` stage may use network only after fingerprint-bound approval, only for the exact frozen no-lifecycle-script command, and only in a `container-required` project. All ordinary post-worker checks remain `--network none`.
- Scope input is deliberately simple: repeat `--allowed-path <relative-root>` and `--forbidden-path <relative-root>` as needed. They are literal repository-relative roots, not a task DSL; the orchestrator independently verifies the resulting paths after the worker finishes.
- `create_branch`, commit, and push are safe operations. A project can require approval for PR creation. Merge and production deploy are approval-required but deliberately have no execution handler. Force-push to `main` and protected-branch deletion are forbidden.
- CI ends as `pending`, `success`, `failure`, or `timeout`. GitHub Check Runs and commit status contexts are both evaluated, paginated with a bounded fail-closed limit, and only the latest status per context is authoritative. A configured Vercel provider only observes preview deployments and treats `READY`, `ERROR`, `NOT_FOUND`, `TIMEOUT`, and `NOT_CONFIGURED` explicitly. There is no automatic merge.

The agent itself is a CLI and is not hosted on Vercel. See [architecture](docs/ARCHITECTURE.md), [safe command execution](docs/V0.5-SAFE-COMMAND-EXECUTION.md), [cross-repository workspaces](docs/CROSS_REPO.md), [Vercel observation](docs/VERCEL_INTEGRATION.md), and [security](docs/SECURITY.md) for implementation detail.
