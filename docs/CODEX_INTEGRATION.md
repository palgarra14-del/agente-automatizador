# Codex integration

## Decision

The real worker uses the official TypeScript package `@openai/codex-sdk`, not UI automation, browser control, Playwright, or an invented API. The SDK is the preferred integration for an application that starts, resumes, and controls local Codex threads; it is a Node 18+ server-side library. It wraps the local Codex runtime and exchanges structured events. The SDK documentation also supports workspace sandboxing and persistent thread IDs.

The lower-level `codex exec` interface remains an official non-interactive option, but it is not the application integration in v0.2. The SDK provides the required thread lifecycle and structured result directly, so it takes precedence here.

## Execution

`CodexSdkWorker` calls `startThread` with:

- `workingDirectory`: the workspace pre-validated by the Orchestrator;
- `sandboxMode: workspace-write`;
- `approvalPolicy: never` only inside that sandbox, for non-interactive coding work;
- network and web search disabled.

The worker receives a redacted `CodingTask`. It returns a final response, usage data, and the SDK thread ID; the orchestrator masks and persists these fields. The worker timeout is enforced with `AbortSignal`. A failure or timeout is a worker failure and consumes the bounded retry budget.

## Authentication

The SDK can use saved local Codex authentication. For controlled API-key automation it can receive `CODEX_API_KEY` only in the SDK process; the worker task never contains it. `GITHUB_TOKEN` is used separately by `GitHubAdapter` and is deliberately removed from the worker environment. For CI, use separate jobs/credentials for untrusted checkout code and privileged GitHub writes.

## Limits

The worker is limited by `commandTimeoutMs`-derived worker timeout, `maxRuntimeMinutes`, and `maxWorkerAttempts`. Project checks come only from project configuration. No model-call counter is claimed because the deterministic planner does not make model calls. The default JSON state store is single-writer.

## Why this is safe enough for v0.2

The Orchestrator creates and verifies the branch, validates history and changed paths, runs checks, commits, pushes, creates the PR, observes CI, and refuses merge. The SDK worker cannot override those controls. The worker's network is disabled and its sandbox prevents writing outside the workspace. This does not replace human review: every generated PR remains unmerged.

## References

- [Codex SDK — official OpenAI documentation](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex non-interactive mode — official OpenAI documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
