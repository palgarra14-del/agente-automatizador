# Architecture

One Node process coordinates a configured project. The orchestrator creates a persistent run, uses a planner, obtains repository facts through an adapter, executes only configured commands, evaluates deterministic criteria and emits a report. JSON storage is atomically replaced, human-inspectable and makes each run recoverable by ID. Adapters isolate GitHub, deployments and workers; the coding worker is a safe mock in v0.1.

Official Codex SDK integration is deferred to v0.2 because it needs a configured local Codex environment and credentials. No unsupported UI automation is used.
