# Governed runtime provisioning

The runtime maintenance plane is intentionally separate from normal workflow execution.

Normal project checks still run with Docker `--pull never` and post-worker network disabled. `agent runtime sync` and `agent service bootstrap` are the explicit maintenance surfaces that may prepare registered runtime images.

## Digest-pinned images

A missing image referenced by exact `@sha256:<64 hex>` digest may be pulled. The pull uses a fresh empty Docker configuration directory, receives only a minimal `PATH`/`CI` environment, and is followed by an exact image inspection. Mutable tags are never pulled through this path.

## Reviewed local build recipes

`config/runtime-images.json` is a versioned registry for local images that cannot be addressed by an immutable registry digest. Each recipe binds:

- the exact local image name;
- a repository-relative build context;
- a repository-relative Dockerfile;
- the SHA-256 of that Dockerfile.

Paths must be real non-symlink paths beneath the repository root. The Dockerfile must be a single-linked regular file inside the declared context and must match the registered SHA-256 before Docker build is invoked.

The build uses `--pull=false`, an empty temporary Docker config, the exact verified Dockerfile/context, and a runtime recipe label derived from the normalized recipe fingerprint. The resulting image is accepted only when a post-build inspection finds that exact fingerprint label.

A pre-existing local image with the right tag but a missing/stale recipe fingerprint is not trusted. Runtime status reports it as `stale-recipe`; runtime sync rebuilds it from the reviewed recipe and verifies the new label.

This gives LeadFinder's `agent-node22-pnpm11:local` image a governed preparation path while preserving the rule that ordinary agent workflows cannot silently acquire network or arbitrary Docker-build authority.
