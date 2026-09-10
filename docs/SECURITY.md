# Security

## Authority boundaries

The CodingWorker edits code only. The Orchestrator owns repository identity, workspace, branch policy, budgets, configured checks, commits, pushes, GitHub writes, CI polling, and state persistence. The worker prompt expressly prohibits Git history/remote operations, deployment, secret handling, and policy changes.

The official SDK worker starts a thread with `workspace-write`, `networkAccessEnabled: false`, and `webSearchMode: disabled`. Its explicit environment allowlist omits `GITHUB_TOKEN`, `CODEX_API_KEY`, and other inherited secrets. Codex authentication is recovered only from the local Codex runtime configuration or injected by the SDK, never included in the worker task.

## Git and paths

- Only an ID in `config/projects.json` is eligible for a run; the LLM cannot supply the repository URL, owner, repo, workspace root, or branch pattern.
- Managed workspaces must resolve below `.agent-workspaces/<project>/<runId>` and reject escaped paths and symlinked workspace roots. They are never reused across projects or runs.
- The clone remote and the checked-out remote must both match the configured GitHub owner/repository.
- A run requires a clean checkout and creates an allowlisted `agent/<runId>` branch from protected `main`; it does not write the caller's current branch.
- Commit and push methods assert the working branch and never use force-push.
- `.env`, key, PEM, and secret-named files are rejected before staging. A detected Git-history mutation by the worker fails the run.

## Commands, budgets, and logs

Install and validation commands come only from `config/projects.json`, reject shell metacharacters, run with `shell: false`, time out, and have output capped. The worker cannot supply commands. Active budgets include `maxTasks`, `maxRuntimeMinutes`, `commandTimeoutMs`, `ciTimeoutMs`, `ciPollIntervalMs`, `deploymentTimeoutMs`, `deploymentPollIntervalMs`, and `maxWorkerAttempts`.

Known GitHub, OpenAI, Vercel, Bearer, and key-like values are redacted before persistence or report output. No token belongs in project configuration, prompts, logs, source files, or commits. `VERCEL_TOKEN` is read only by the deployment adapter and Vercel is queried only with GET requests; deployment, promotion, rollback, domains, and environment settings have no execution path.

## Approvals

Approval and execution are separate. Project configuration may make PR creation approval-required. Merge and production deployment always need approval but have no execution handler in v0.2. Force-pushing main, bypassing approval, disabling security, and protected-branch deletion are forbidden even if a project config requests otherwise.
