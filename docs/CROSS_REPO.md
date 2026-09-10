# Cross-repository workspaces

Every registered v0.3 run uses `.agent-workspaces/<projectId>/<runId>`. `WorkspaceManager` calculates that path from the project registry, rejects path escape and symbolic links, and clones only `https://github.com/<configured-owner>/<configured-repository>.git`. The controlled Git adapter then verifies the origin, fetches the configured default branch, locks its SHA to GitHub's branch API response, and creates the allowed working branch at that object.

The host checkout is not reused for target edits. A `self` run and a `leadfinder` run therefore have different directories, branches, clones, and audit evidence. Workspaces are retained after both successful and failed runs for debugging; there is intentionally no broad cleanup command in v0.3.

`--dry-run` only calculates the workspace. It does not create it, clone, fetch, invoke Codex, install dependencies, run checks, commit, push, create a PR, poll CI, or query Vercel.
