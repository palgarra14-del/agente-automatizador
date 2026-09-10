# Vercel preview observation

`VercelDeploymentProvider` is a read-only adapter. For a project configured with `provider: vercel`, `projectId`, and `teamId`, it uses `VERCEL_TOKEN` only in its own process to list deployments and selects the preview whose Git metadata matches the controlled commit SHA and branch. It persists deployment ID, environment, URL, state, and creation time.

The bounded poll reports `READY`, `ERROR`, `NOT_FOUND`, `TIMEOUT`, or `NOT_CONFIGURED`. A project may include `deployment` in its acceptance requirements, in which case only `READY` passes evaluation. The adapter never calls deploy, promote, rollback, domain, or environment-variable endpoints. The Engineering Orchestrator itself remains a CLI and is not deployed to Vercel.
