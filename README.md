# Engineering Orchestrator — MVP v0.1

CLI-first foundation for persistent and governed engineering runs. It is not an autonomous production deployer and it never bypasses approvals.

Requires Node 22+.

```bash
node src/cli.js run --project self --goal "Verify repository health"
node src/cli.js run --project self --goal "Check merge" --request-action merge
node src/cli.js approvals
node src/cli.js run --project self --goal "Plan only" --dry-run
```

Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. Projects live in `config/projects.json`; state/audit events are stored in `.agent/state.json` and never committed.
