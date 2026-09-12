# Codex integration

## Decision

The real model workers use the official `@openai/codex-sdk`; there is no UI/browser automation around Codex. WorkflowEngine separates a workspace-write coding worker from read-only analysis/critic workers, while deterministic orchestration owns Git, commands, approvals, publication and budgets.

## Execution boundary

`CodexSdkWorker` and `CodexReadOnlySkillExecutor` start SDK threads in the already validated workflow workspace with `approvalPolicy: never` and web search disabled. Security is supplied through the reviewed SDK permission profile rather than a caller-selected sandbox flag:

- filesystem root denied; only the workflow workspace is exposed, write for the coding worker and read for analysis/critic workers; `.git` is read-only;
- network disabled;
- login shell disabled and environment inheritance removed except an explicit PATH/CI set;
- project instructions, skills, plugins/apps/connectors/browser/computer-use/hooks/multi-agent/memory features disabled;
- ephemeral/no-history operation;
- project `.codex/config.toml` / `.codex/requirements.toml` controls are rejected before the worker starts.

The orchestrator independently snapshots repository identity, Git control state, protected ignored files and the governed diff before/after model execution. A worker cannot make its own result authoritative.

## Authentication and secrets

Workers use saved local Codex authentication copied into a private temporary isolated Codex home. The implementation deliberately does not inject `CODEX_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN` or `VERCEL_TOKEN` into the worker. GitHub/Vercel credentials remain in separate orchestrator adapters.

v0.14 does not move Codex authentication to GitHub Actions. The supervised issue queue is only a remote control/approval channel; the actual agent/Codex process remains local.

## Model-call limits

Every registered run/workflow has a persisted `maxModelCalls` ceiling (currently six for registered projects). A call is reserved before invocation and remains consumed after interruption/retry. SDK token usage is recorded when available; missing usage is marked unknown. This is a hard call-count governor, not an exact monetary-spend guarantee.

The structured website happy path normally uses three calls (planner, implementer, critic). App-improvement normally uses inspection, diagnosis, implementer and critic calls subject to the same ceiling.

## Publication ownership

Codex never chooses commits, pushes, pull requests, CI policy, preview observation, merge or production actions. Controlled code revalidates the exact reviewed fingerprint before review-only publication. WorkflowEngine has no merge/production handler.

## Platform boundary

The current worker isolation profile is verified for Linux and macOS. Native Windows worker execution fails closed; a Windows operator should use a supported Linux environment such as WSL2 rather than weakening the boundary.

## Remaining hardening

The worker still runs under the operator OS account even though SDK filesystem/network capabilities are restricted. A dedicated low-privilege OS/container/VM boundary for the coding worker remains a future defense-in-depth improvement. Exact spend enforcement is also deferred until trustworthy usage/pricing evidence can support it.
