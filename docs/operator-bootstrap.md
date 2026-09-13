# One-command operator bootstrap

The operator can now be prepared from a checked-out repository with one command:

```bash
node scripts/bootstrap-operator.js
```

This entry point is intended for the user's WSL/Linux operator host. It deliberately fails on native Windows rather than weakening the existing isolation model.

## One-time prerequisites

The host still needs these external prerequisites installed and authenticated once:

- Node.js 22 or newer;
- Docker with a reachable daemon;
- WSL/Linux with systemd available for the persistent user service;
- GitHub CLI already authenticated (`gh auth login`) or an existing suitable `GITHUB_TOKEN`;
- Codex already authenticated for local worker execution.

The bootstrap script does not install or authenticate those external products.

## What the command does

In order, it:

1. validates the repository root and bootstrap control files, rejecting symlinked control paths;
2. runs a frozen `npm ci --ignore-scripts` using an isolated temporary npm home/config/cache that does not receive GitHub, Codex, or Vercel credentials;
3. invokes `agent service bootstrap`, which prepares registered runtime images, synchronizes the persistent inbox service, and synchronizes the WSL login guardian;
4. runs `agent doctor --project callflow` as the final readiness check.

The runtime stage prepares immutable digest-pinned images and the reviewed LeadFinder local image recipe. Ordinary agent workflows still run with Docker `--pull never` and do not inherit this maintenance authority.

The operation is designed to be repeatable: dependencies are refreshed from the lockfile, runtime preparation is state-aware, and the service/guardian synchronizers are ownership-bound and idempotent.

## Security boundary

The bootstrap entry point is part of the agent's control plane. The `self` project therefore treats the entire `scripts/` directory as sensitive, alongside `src/` and `config/`, so future changes to bootstrap logic cannot pass through the normal low-risk change path.
