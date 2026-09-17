# Cloud state v2 protocol

Issues: #180, #182, #193

This document defines the r5 Cloud State v2 authority model. It does not widen merge, deployment, model, secret, identity, or communication authority. The only prerequisite authority change landed separately in #194: the cloud worker may create commit statuses.

## Authority model

Each lane still owns three movable Git refs:

- `stateRef`: the configured lane state tag;
- `checkpointRef`: `agent-cloud-state-v2-checkpoints/<stateTag>`;
- `witnessRef`: `agent-cloud-state-v2-witnesses/<stateTag>`.

These refs are operational pointers only. They are not the final monotonic root of trust because the same `contents: write` authority can force-move or delete all of them outside this implementation.

The monotonic authority is an append-only commit-status ledger attached to the repository's verified parentless root commit:

`b4f3b2e76e24be58d241227850a5d48ea19c2ea8`

Before trusting the ledger, the store reads that exact Git commit and requires zero parents.

GitHub exposes list/create operations for commit statuses but no status update/delete operation. The implementation therefore has only an append path for authority records. A later writer can append a conflicting record, but it cannot erase the older record through this API; any conflicting record for the same lane generation fails closed.

## Lane and generation binding

Each store derives a 128-bit lowercase lane digest from the canonical tuple:

- repository;
- lane id;
- state path;
- state tag;
- derived checkpoint tag;
- derived witness tag.

A ledger status context is:

`agent-cloud-state-v2/<laneDigest>/g/<generation>`

Every generation has a distinct context, avoiding GitHub's 1000-status limit for one SHA/context pair.

The status is always created on the immutable root commit with:

- `state = success`;
- no target URL;
- the deterministic context above;
- description `s=<stateSha>;p=<parentSha>`.

The description therefore binds the exact state commit and its exact Git parent. Context matching is treated case-insensitively, matching GitHub status-context semantics.

Duplicate identical records are idempotent and support recovery from an uncertain POST response. Two records for the same lane/generation that disagree on state SHA or parent SHA are corruption/fork evidence and fail closed.

## Ledger scan invariant

A fresh process lists statuses on the immutable root in pages of 100 and filters only the exact lane digest.

For that lane:

1. every matching context must contain a positive safe-integer generation;
2. every matching status must be `success`, have no target URL, and contain the exact `s=<40hex>;p=<40hex>` description;
3. duplicate entries for a generation must be byte-equivalent in authority meaning;
4. generations must be contiguous from the first v2 generation to the newest;
5. each generation's recorded parent SHA must equal the preceding generation's recorded state SHA.

Unrelated status contexts on the same root commit are ignored. Malformed contexts for the exact lane prefix, gaps, or conflicting records fail closed.

## Legacy v1 trust boundary

Cloud State v1 had no independent append-only monotonic authority. A fresh process cannot retroactively prove that a v1 state tag was never force-moved to an older otherwise-valid v1 head.

Migration therefore treats the exact v1 `stateRef` observed at the successful transition as the one-time legacy trust boundary:

- `lineageBaseSha` = exact v1 head SHA;
- `lineageBaseGeneration` = exact v1 envelope generation;
- first v2 generation = legacy generation + 1.

This intentionally preserves inherited generation offsets such as a valid legacy generation that does not equal current Git distance from `main`.

The same unavoidable one-time trust boundary exists for a brand-new lane before its first status record. After the first ledger record exists, monotonic authority is independent of the movable refs.

## Complete v2 lineage validation

Status records prove monotonic publication history, but they do not replace Git/envelope validation.

The newest authoritative status points to an exact v2 state SHA. The store validates the complete v2 lineage from that SHA back to its persisted bootstrap/migration boundary using paginated GitHub GraphQL `Commit.history`, 100 commits per page.

Every v2 state in the chain must satisfy:

- exact SHA continuity;
- exactly one Git parent;
- exact generation continuity;
- a present, non-binary, non-truncated state blob;
- valid JSON envelope;
- correct repository and lane binding;
- exact state path and derived ref names;
- unchanged lineage-base SHA and generation;
- valid state hash;
- project ownership boundaries;
- secret-material boundaries;
- an exact matching status-ledger record for that generation and parent.

The first v2 state must parent its exact lineage base. For a bootstrap, base generation is zero. For migration, the base is the exact validated v1 head and generation.

Pagination is fail-closed: missing nodes, malformed/repeated cursors, incomplete history, hidden merge commits, skipped generations, truncated blobs, malformed intermediate envelopes, or ledger/lineage disagreement all reject the state.

This removes the r3 `ahead_by` shortcut and the r2 per-generation REST explosion. A 2,050-generation v2 chain is tested with both complete ledger and complete lineage validation below the GitHub request cliff.

## Publication protocol

### Brand-new lane or v1 migration

1. Read refs and the lane status ledger.
2. Require the lane ledger to be empty.
3. Validate the exact bootstrap base or exact v1 migration head.
4. Create the first v2 state commit as an exact one-parent child.
5. Advance `stateRef` non-force to that child. This is the single-writer election.
6. Append the first commit-status authority record.
7. Advance checkpoint and witness independently, non-force.
8. Return success only when state, checkpoint, witness and newest status all identify the expected state.

If the process crashes after step 5 but before step 6, ordinary reads fail closed. Governed `repair:true` may create the first status only after proving that the observed v2 state is exactly the first valid child of its persisted bootstrap/migration boundary and that no lane ledger already exists. This is part of the explicit one-time legacy/bootstrap trust boundary; it is not allowed after the ledger has begun.

### Established v2

Given newest immutable authority `(G, S0)`:

1. validate the full ledger and full v2 lineage ending at `S0`;
2. repair mutable refs to `S0` on a governed mutation path if necessary;
3. derive generation `G+1` only from the exact parent envelope;
4. create child state commit `S1` with sole parent `S0`;
5. advance `stateRef` non-force from `S0` to `S1`; only one sibling writer can win;
6. append status context for `G+1`, binding `S1` and parent `S0`;
7. advance checkpoint and witness independently, non-force;
8. verify all final pointers plus newest ledger authority before success.

A writer that loses the state-ref election does not append authority.

## Crash recovery

### State ref one generation ahead of status authority

A crash may occur after the state CAS but before the status POST. Ordinary reads report partial publication and never write.

Governed repair may append exactly one next-generation status only if:

- current state is generation `G+1`;
- its Git parent is exactly authoritative state `S0` at generation `G`;
- all envelope and lineage-base bindings are valid;
- the status ledger has not changed since observation;
- no competing status already claims `G+1`.

After appending, complete lineage is revalidated before mutable watermark repair.

A state more than one generation ahead of immutable authority cannot arise from the supported publication protocol and fails closed.

### Status authority newer than movable refs

If the immutable ledger is newer than state/checkpoint/witness, ordinary reads report rollback. Governed repair may only move each ref forward, non-force, to the fully validated authoritative SHA. Divergent or already-ahead refs fail closed.

This includes a forced joint rollback of all three movable refs: the append-only status history remains visible and prevents a fresh process from accepting the older state.

### Missing or stale checkpoint/witness

Checkpoint and witness are redundant operational acknowledgements. If `stateRef` already equals the immutable authority, ordinary reads may return the authoritative state without writing. Governed repair may move missing/stale watermarks forward after ancestry validation.

## Same-generation conflicts

A same-generation sibling cannot silently replace authority:

- existing status context for generation `G` permanently exposes the previously recorded SHA;
- forcing all three Git refs to a sibling does not change that status record;
- fresh validation detects the state/authority divergence;
- appending a second conflicting status for the same generation creates an explicit ledger conflict rather than selecting a winner.

Identical duplicate statuses are accepted only as idempotent evidence of the same authority record.

## Read purity

Ordinary `load()` and preflight reads perform zero mutations. GraphQL is used only as a read query even though it is transported with HTTP POST.

State file content is always read by exact commit SHA, never through a moving tag.

Only governed recovery/mutation paths may:

- move mutable refs forward non-force;
- append a missing first status during the one-time bootstrap/migration recovery case;
- append one missing next-generation status after proving an exact direct child of existing immutable authority.

No recovery path force-updates a Git ref, rewrites/deletes a status, or rolls authority backward.

## Concurrency

Two writers may construct sibling candidate commits from the same authoritative parent. The non-force `stateRef` update elects at most one sibling because the losing sibling is not a descendant of the newly elected child.

Only the elected child is eligible to append the next status. If a conflicting status is externally appended, the immutable conflict remains visible and the lane fails closed.

Concurrent recovery is safe only when all independently observed refs and ledger authority still match the expected pre-state. Otherwise recovery conflicts and re-reads rather than guessing.

## Request budget

Status-ledger reads paginate at 100 statuses per request. Complete Git lineage reads paginate at 100 commits per GraphQL request.

The adversarial suite includes an established 2,050-generation v2 chain and requires complete fresh-process ledger + lineage validation below 100 GitHub requests in the in-memory transport model. Legacy migration beyond 2,048 generations is also tested separately and does not traverse all v1 history because v1 has no retroactive monotonic proof to recover.

Every generation uses a unique status context, so the GitHub limit of 1000 statuses per SHA/context is not approached during normal monotonic publication.

## Required adversarial regressions

The final candidate must cover at least:

- verified parentless immutable ledger root;
- brand-new bootstrap and exact-SHA read purity;
- multi-generation v1 migration;
- inherited legacy generation offsets;
- legacy history deeper than 2,048 with bounded traffic;
- crash after first-v2 state CAS but before first status append;
- stale v1 writer racing migration;
- lane-isolated status contexts;
- joint rollback of state/checkpoint/witness with newer status authority surviving;
- missing/stale movable watermarks and forward-only repair;
- same-generation sibling with all movable refs forced to it;
- conflicting and identical duplicate status records;
- malformed lane status records;
- status-generation gaps;
- two stale writers and one state-CAS winner;
- crash after established state CAS but before status append;
- checkpoint and witness write failures after status authority exists;
- hidden intermediate merge;
- malformed intermediate envelope;
- truncated historical state blob;
- lineage-anchor rewrite;
- unrelated statuses on the same root commit;
- complete 2,050-generation v2 ledger and lineage below request budget;
- exact-SHA content reads;
- global/execution lease semantics;
- remote envelope integrity failure.

## Merge gate

The exact implementation SHA must pass:

- full unit/adversarial tests;
- real Chrome/CDP Browser QA smoke;
- adversarial Chrome smoke;
- typecheck;
- lint;
- build;
- prepared Node/pnpm runtime image;
- real Docker execution boundary;
- fresh independent adversarial review on frozen exact bytes with zero unresolved P1/P2.

Any unresolved authority, rollback, status-ledger, fork, generation, mixed-version, TOCTOU, lineage, request-budget, lane-isolation, path/ref-binding, scope, or secret-boundary P1/P2 blocks merge.

The Cloud State implementation PR remains limited to the three paths authorized by #182:

- `src/cloud-state.js`
- `test/cloud-state.test.js`
- `docs/CLOUD_STATE_V2_PROTOCOL.md`

No merge, deployment, or production authority is added here.