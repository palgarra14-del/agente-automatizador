# Cloud state v2 protocol

Issues: #180, #182, #193

This document defines the r5 Cloud State v2 authority model. It does not widen merge, deployment, model, secret, identity, or communication authority. The only prerequisite authority change landed separately in #194: the cloud worker may create commit statuses.

## Authority model

Each lane still owns three movable Git refs:

- `stateRef`: the configured lane state tag;
- `checkpointRef`: `agent-cloud-state-v2-checkpoints/<stateTag>`;
- `witnessRef`: `agent-cloud-state-v2-witnesses/<stateTag>`.

These refs are operational pointers only. They are not the final monotonic root of trust because the same `contents: write` authority can move or delete all of them outside this implementation.

The durable monotonic evidence is an append-only commit-status log attached to the repository's verified parentless root commit:

`b4f3b2e76e24be58d241227850a5d48ea19c2ea8`

Before trusting any Cloud State status, the store reads that exact Git commit and requires zero parents.

GitHub exposes creation and listing of commit statuses, but no status update/delete operation. The implementation therefore only appends status evidence. New conflicting evidence cannot erase older evidence; conflicts fail closed.

r5 distinguishes two immutable status kinds:

1. **candidate intent** — written before the state-ref compare-and-swap and proving that a specific candidate existed before it could become the movable state head;
2. **canonical authority** — written only after that exact candidate wins the non-force state-ref election.

A canonical authority record is trusted only when a matching immutable candidate intent already exists for the same generation, state SHA and parent SHA.

This ordering closes the authority bridge that existed in earlier r5 drafts: a v2 commit placed into `stateRef` only through mutable `contents: write` cannot later be blessed by governed repair unless the exact candidate had already published its immutable intent before the ref move.

## Lane, generation, and status binding

Each store derives a 128-bit lowercase lane digest from the canonical tuple:

- repository;
- lane id;
- state path;
- state tag;
- derived checkpoint tag;
- derived witness tag.

Canonical authority context:

`agent-cloud-state-v2/<laneDigest>/g/<generation>`

Candidate-intent context:

`agent-cloud-state-v2/<laneDigest>/i/<generation>/<candidateToken>`

`candidateToken` is the first 24 hexadecimal characters of the exact candidate state SHA. The full state SHA remains present in the deterministic description and is revalidated when parsing the intent.

Every status is created on the immutable root commit with:

- `state = success`;
- no target URL;
- one of the deterministic contexts above;
- description `s=<stateSha>;p=<parentSha>`.

The description binds the exact state commit and exact Git parent. Context matching is case-insensitive, matching GitHub commit-status context semantics.

Generation-specific canonical contexts avoid GitHub's 1000-status limit for one SHA/context pair. Candidate intents additionally use a candidate-specific token so two sibling candidates for the same generation do not overwrite or semantically alias one another.

Identical duplicate intent or authority records are idempotent and support recovery from an uncertain POST response. Conflicting records for the same semantic slot are corruption/fork evidence and fail closed.

## Status-evidence scan invariant

A fresh process lists statuses on the immutable root in pages of 100 and filters only the exact lane digest.

For that lane:

1. every matching context must encode a positive safe-integer generation;
2. every matching status must be `success`, have no target URL, and contain exact `s=<40hex>;p=<40hex>` evidence;
3. every intent token must match the prefix of the full state SHA in its description;
4. duplicate intents for one generation/state candidate must agree on parent SHA;
5. duplicate canonical entries for one generation must agree on state SHA and parent SHA;
6. every canonical generation must have an exact matching intent for the same generation, state SHA and parent SHA;
7. canonical generations must be contiguous from the first v2 generation to the newest;
8. each canonical generation's parent SHA must equal the preceding canonical generation's state SHA.

Unrelated status contexts on the same root commit are ignored. Malformed lane contexts, missing intents for canonical authority, canonical gaps, intent conflicts, or canonical conflicts fail closed.

Candidate intents without canonical authority are allowed. They represent candidates that lost the state-ref election or publication attempts that stopped before canonicalization. They never become state authority by themselves.

## Legacy v1 trust boundary

Cloud State v1 had no independent append-only monotonic authority. A fresh process cannot retroactively prove that a v1 state tag was never force-moved to an older otherwise-valid v1 head.

Migration therefore treats the exact v1 `stateRef` used to construct the winning v2 candidate as the one-time legacy trust boundary:

- `lineageBaseSha` = exact v1 head SHA;
- `lineageBaseGeneration` = exact v1 envelope generation;
- first v2 generation = legacy generation + 1.

This intentionally preserves inherited generation offsets such as a valid legacy generation that does not equal current Git distance from `main`.

A brand-new lane similarly has a one-time bootstrap boundary at the exact configured base-branch SHA used as the first candidate's parent. For bootstrap, `lineageBaseGeneration = 0`.

The first immutable candidate intent must be appended before either bootstrap or migration can move `stateRef`. After the first canonical authority record exists, monotonic authority is independent of the movable refs.

## Complete v2 lineage validation

Status evidence proves monotonic publication history, but it does not replace Git/envelope validation.

The newest canonical authority points to an exact v2 state SHA. The store validates the complete canonical v2 lineage from that SHA back to its persisted bootstrap/migration boundary using paginated GitHub GraphQL `Commit.history`, 100 commits per page.

Every canonical v2 state in the chain must satisfy:

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
- an exact matching canonical status for that generation and parent;
- an exact matching immutable intent for that canonical status.

The first canonical v2 state must parent its exact lineage base. For bootstrap, base generation is zero. For migration, the base is the exact validated v1 head and generation.

Pagination is fail-closed: missing nodes, malformed/repeated cursors, incomplete history, hidden merge commits, skipped generations, truncated blobs, malformed intermediate envelopes, missing intents, or status/lineage disagreement all reject the state.

This removes the r3 `ahead_by` shortcut and the r2 per-generation REST explosion. A 2,050-generation v2 chain is tested with complete status evidence and complete lineage validation below the GitHub request cliff in the in-memory transport model.

## Publication protocol

### Brand-new lane or v1 migration

1. Read refs and complete lane status evidence.
2. Require the canonical lane ledger to be empty.
3. Validate the exact bootstrap base or exact v1 migration head.
4. Create the first v2 state commit as an exact one-parent child.
5. Append immutable candidate intent for `(generation, candidateSha, parentSha)`.
6. Advance `stateRef` non-force from the expected predecessor to that candidate. This is the single-writer election.
7. Re-read status evidence and append canonical authority only for that exact candidate, requiring its matching intent.
8. Advance checkpoint and witness independently, non-force.
9. Return success only when state, checkpoint, witness and newest canonical authority all identify the expected state.

If intent append fails before the state CAS, the candidate has no authority and `stateRef` is not moved.

If the process crashes after intent append but before the state CAS, the orphan intent remains immutable but harmless. It has no canonical authority and no ref election win.

If the process crashes after the state CAS but before canonical authority append, ordinary reads fail closed. Governed `repair:true` may append the canonical record only when the exact state candidate already has a matching immutable intent and all first-v2 ancestry/envelope constraints still hold. Repair never creates the missing intent.

A first-v2 state placed into mutable refs without a pre-existing matching intent cannot be blessed by repair.

### Established v2

Given newest canonical authority `(G, S0)`:

1. validate the complete canonical ledger and complete v2 lineage ending at `S0`;
2. repair mutable refs back to `S0` on a governed mutation path if they are missing/stale and only forward repair is valid;
3. derive generation `G+1` only from the exact authoritative parent envelope;
4. create child candidate state commit `S1` with sole parent `S0`;
5. append immutable candidate intent binding `(G+1, S1, S0)`;
6. advance `stateRef` non-force from `S0` to `S1`; only one sibling candidate can win;
7. append canonical authority for `(G+1, S1, S0)`, requiring the matching intent to still be present and the canonical ledger to still end at `(G, S0)`;
8. advance checkpoint and witness independently, non-force;
9. verify all final pointers plus newest canonical authority before success.

A writer that loses the state-ref election may leave an immutable intent, but it does not gain canonical authority. The losing intent is inert evidence and does not create a fork by itself.

## Crash recovery

### State ref one generation ahead of canonical authority

A crash may occur after a candidate intent and successful state CAS but before canonical authority append. Ordinary reads report partial publication and never write.

Governed repair may append exactly one next-generation canonical record only if:

- current state is generation `G+1`;
- its Git parent is exactly canonical state `S0` at generation `G`;
- all envelope and lineage-base bindings are valid;
- a matching immutable candidate intent for `(G+1, currentState, S0)` already exists;
- the canonical ledger has not changed since observation;
- no competing canonical status already claims `G+1`.

Repair does **not** synthesize or append a missing intent. Therefore a mutable state ref moved outside the supported publication sequence cannot self-promote into durable authority through repair.

After canonical append, complete lineage is revalidated before mutable watermark repair.

A state more than one generation ahead of canonical authority cannot arise from the supported publication protocol and fails closed.

### Canonical authority newer than movable refs

If canonical authority is newer than state/checkpoint/witness, ordinary reads report rollback when appropriate. Governed repair may only move each ref forward, non-force, to the fully validated authoritative SHA. Divergent or already-ahead refs fail closed.

This includes a forced joint rollback of all three movable refs: append-only canonical history remains visible and prevents a fresh process from accepting the older state.

### Missing or stale checkpoint/witness

Checkpoint and witness are redundant operational acknowledgements. If `stateRef` already equals immutable canonical authority, ordinary reads may return the authoritative state without writing. Governed repair may move missing/stale watermarks forward after ancestry validation.

## Same-generation candidates and conflicts

Multiple sibling candidates may publish intents for the same next generation. That is expected under concurrency.

Only one sibling can win the non-force state-ref election. Only the exact elected candidate with its prior intent is eligible for canonicalization.

A same-generation sibling cannot silently replace canonical authority:

- existing canonical context for generation `G` exposes the previously recorded SHA;
- forcing all three Git refs to a sibling does not change that canonical record;
- fresh validation detects state/authority divergence;
- appending a second conflicting canonical status for the same generation creates an explicit immutable conflict rather than selecting a winner.

A conflicting intent for the same generation and exact state SHA but a different parent also fails closed. Different sibling state SHAs may retain separate intents without authority.

## Read purity

Ordinary `load()` and preflight reads perform zero mutations. GraphQL is used only as a read query even though it is transported with HTTP POST.

State file content is always read by exact commit SHA, never through a moving tag.

Only governed publication/recovery paths may:

- append a candidate intent before a state-ref election;
- append canonical authority only when matching immutable intent exists;
- move mutable refs forward non-force;
- complete a missing canonical status after a proven crash only when the exact pre-CAS intent already exists.

No recovery path creates a missing intent from mutable refs, force-updates a Git ref, rewrites/deletes a status, or rolls canonical authority backward.

## Concurrency

Two writers may construct sibling candidate commits from the same authoritative parent and append separate immutable intents.

The non-force `stateRef` update elects at most one sibling because the losing sibling is not a descendant of the newly elected child. A losing intent remains non-authoritative.

Before canonicalization, the winner re-reads status evidence. Canonical append is valid only while the previous canonical authority still matches the expected parent and the winner has the exact matching intent.

If a conflicting canonical status is externally appended, the immutable conflict remains visible and the lane fails closed.

Concurrent recovery is safe only when independently observed refs and canonical authority still match the expected pre-state. Otherwise recovery conflicts and re-reads rather than guessing.

## Request budget

Status-evidence reads paginate at 100 statuses per request. Complete Git lineage reads paginate at 100 commits per GraphQL request.

Normal successful publication produces two status entries per canonical generation: one intent and one canonical authority. Lost concurrent candidates can add extra orphan intents, so status traffic is explicitly included in request-budget tests and review.

The adversarial suite includes an established 2,050-generation v2 chain and requires complete fresh-process status evidence plus lineage validation below 100 GitHub requests in the in-memory transport model. Legacy migration beyond 2,048 generations is also tested separately and does not traverse all v1 history because v1 has no retroactive monotonic proof to recover.

Every canonical generation uses a unique canonical status context, and every candidate intent uses a candidate-specific context, so the GitHub limit of 1000 statuses per SHA/context is not approached during normal publication.

## Required adversarial regressions

The final candidate must cover at least:

- verified parentless immutable ledger root;
- brand-new bootstrap with intent before canonical authority and exact-SHA read purity;
- multi-generation v1 migration;
- inherited legacy generation offsets;
- legacy history deeper than 2,048 with bounded traffic;
- crash after first-v2 state CAS but before canonical append, recoverable only with prior intent;
- first-v2 mutable state without intent cannot be blessed by repair;
- stale v1 writer racing migration;
- lane-isolated canonical and intent contexts;
- intent is appended before canonical authority in normal publication;
- joint rollback of state/checkpoint/witness with newer canonical authority surviving;
- missing/stale movable watermarks and forward-only repair;
- same-generation sibling with all movable refs forced to it;
- established-v2 mutable child without matching intent cannot be blessed by repair;
- identical duplicate status evidence is idempotent;
- conflicting canonical records fail closed;
- conflicting intents for the same candidate fail closed;
- canonical authority without matching intent fails closed;
- malformed lane status records fail closed;
- canonical generation gaps fail closed;
- two stale writers may leave sibling intents but only the state-CAS winner becomes canonical;
- crash after established state CAS but before canonical append;
- checkpoint and witness write failures after canonical authority exists;
- hidden intermediate merge;
- malformed intermediate envelope;
- truncated historical state blob;
- lineage-anchor rewrite;
- unrelated statuses on the same root commit;
- complete 2,050-generation v2 evidence and lineage below request budget;
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

Any unresolved authority, rollback, status-evidence, intent/canonical ordering, fork, generation, mixed-version, TOCTOU, lineage, request-budget, lane-isolation, path/ref-binding, scope, or secret-boundary P1/P2 blocks merge.

The Cloud State implementation PR remains limited to the three paths authorized by #182:

- `src/cloud-state.js`
- `test/cloud-state.test.js`
- `docs/CLOUD_STATE_V2_PROTOCOL.md`

No merge, deployment, or production authority is added here.