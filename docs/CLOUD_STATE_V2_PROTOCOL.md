# Cloud state v2 protocol

Issue: #180

This document fixes the authority model before implementation. It does not widen execution, merge, deploy, model, secret, or communication authority.

## Durable refs per lane

Each lane owns three refs in the same repository:

- `stateRef`: the existing configured lane state tag. It points at the newest published state commit.
- `checkpointRef`: a lane-specific durable watermark derived as `agent-cloud-state-v2-checkpoints/<stateTag>`.
- `witnessRef`: a second independent lane-specific durable watermark derived as `agent-cloud-state-v2-witnesses/<stateTag>`.

Process memory is never authoritative. A completed publication leaves all three refs at the same exact state commit SHA.

The watermark namespaces are reserved by construction. Configured state tags use the existing grammar that excludes `/`, while both watermark refs always contain `/`; checkpoint and witness also live under different prefixes. The store derives both watermark names from the validated state tag and does not accept caller-selected watermark names. The namespace roots `agent-cloud-state-v2-checkpoints` and `agent-cloud-state-v2-witnesses` are themselves forbidden as configured state tags because Git cannot contain both a ref and a child ref beneath the same path.

The two watermark refs are redundant on purpose: loss or deletion of one watermark must not erase the cross-process monotonic proof carried by the other. If both watermarks are unavailable after v2 has begun, the store fails closed rather than re-trusting `stateRef`.

All v2 envelopes are bound to repository, lane id, state path, state ref name, checkpoint ref name, witness ref name, generation and state hash.

## Bounded lineage proof

Cloud State must remain valid when a lane has thousands or millions of generations. Validation therefore must not issue one GitHub REST request per historical generation.

The durable state history has a stronger structural invariant: every accepted state generation is exactly one single-parent Git commit on the lane's state-side history, beginning from a commit in the configured base branch history. GitHub's compare response already exposes `ahead_by`, the number of commits on the state side since the merge base with the configured base branch.

For any trusted legacy or v2 state SHA `S` with envelope generation `G`:

1. Read `S` and its state file by exact SHA.
2. Require the exact state commit to have one parent.
3. Resolve the configured base branch by exact SHA.
4. Compare `baseBranchSHA...S` once through the Git commit graph.
5. Require comparison status to be `ahead` or `diverged` and require `ahead_by == G` exactly.

This is the global generation/ancestry invariant. A skipped generation, malformed bootstrap, hidden extra state-side commit, or superficially valid child over the malformed generation-2 case changes the state-side commit distance and is rejected. The proof costs a constant number of REST calls independent of generation count.

The compare payload is validated rather than trusted loosely: missing, negative or non-integer `ahead_by`/`behind_by` values fail closed as `cloud_state_compare_invalid`.

Direct in-flight publication recovery remains stricter than the global count: when a watermark and `stateRef` differ, the newer ref must be the exact one-parent child of the trusted SHA and its envelope generation must be exactly parent generation + 1.

## One-time legacy v1 migration

The configured `stateRef` already contains the real v1 durable history. Migration must not keep an arbitrary v1 head permanently eligible for bootstrap recovery.

When `stateRef` is v1 and both watermark refs are absent:

1. Read the v1 state by exact commit SHA and validate repository/lane ownership, state hash and secret boundaries.
2. Validate the legacy head with the bounded lineage proof above. There is no fixed generation-count cutoff and no per-generation REST traversal.
3. Re-read all refs and require the same migration pre-state.
4. Create a new v2 migration commit whose parent is exactly the validated v1 head and whose generation is exactly parent generation + 1. The logical state may include the governed mutation that triggered migration.
5. Advance `stateRef` non-force to the v2 migration commit.
6. Attempt `checkpointRef` and `witnessRef` independently at that same commit. A failure of one must not prevent attempting the other.
7. Return success only after all three refs resolve to the exact v2 migration SHA; otherwise return an explicit partial-publication error.

If an old v1 writer wins the state-ref race before publication, migration must conflict and restart from the new exact v1 head. Once `stateRef` has advanced to a v2 commit, an old v1 writer holding the previous v1 parent cannot non-force advance the ref. A v1 descendant must never be accepted after either watermark exists or v2 migration has begun.

If `stateRef` is already v2 and both watermarks are absent, the state is a hard partial publication. It must fail closed and require explicit operator recovery that preserves the newer exact state SHA; a normal read/mutation must never recreate trust automatically from `stateRef` alone.

## Read invariant

A fresh process reads all refs by exact SHA before reading any state content.

Let `S` be `stateRef`, `C` be `checkpointRef`, and `W` be `witnessRef`.

1. If `S`, `C` and `W` are all absent, bootstrap from the configured base branch.
2. If `S` is absent while either watermark exists, fail closed as partial/corrupt publication.
3. If `S` is v1 and both watermarks are absent, only the one-time legacy migration path above is eligible on a governed write; ordinary reads remain read-only.
4. If `S` is v2 and both watermarks are absent, validate enough exact-SHA evidence to classify the state, then fail closed. Never reinterpret it as first migration.
5. If exactly one watermark exists, it is the durable authority witness. `S` must be either that exact commit or one validated direct v2 child. The missing watermark may be reconstructed only during a governed repair after exact-SHA validation and a fresh ref re-check.
6. If both watermarks exist and differ, either one may be the newer direct v2 child because publication attempts them independently. Prove their exact parent/child relationship and generation +1 continuity, then use the newer watermark as the trusted SHA. Divergent or multi-step watermark gaps fail closed.
7. A trusted v2 watermark is validated with the bounded lineage proof even when all refs agree. Matching refs alone never authorize a skipped generation or malformed bootstrap/history distance.
8. `stateRef` may equal the newest watermark or be one validated direct v2 child ahead of it as the result of an interrupted publication. A state ref behind a surviving newer watermark is rollback evidence and is rejected.
9. If neither side is ancestor of the other, reject `cloud_state_history_fork`.
10. State content is always read by exact commit SHA, never through a moving tag.
11. Ordinary `load()`/preflight reads never mutate refs. Watermark repair occurs only on an explicitly governed mutation/recovery path.

A numerically higher generation never substitutes for ancestry proof. The generation must equal the Git commit distance that independently represents that state-side history.

## Write protocol

Given a validated snapshot whose exact state SHA is `S0` and both durable watermarks resolve to `S0` (or a validated legacy v1 snapshot with no watermarks):

1. Re-read all three refs immediately before publication and require them to still match the validated snapshot.
2. Re-read the exact parent envelope and validate its bounded lineage proof; derive the next generation from that exact envelope. Caller-supplied or mutable snapshot generation is never authoritative.
3. Create blob, tree and v2 state commit `S1` with parent exactly `S0` (or the configured base commit for a brand-new lane).
4. Publish `stateRef -> S1` with a non-force update.
5. Attempt `checkpointRef -> S1` and `witnessRef -> S1` independently with non-force updates. Do not skip the second watermark merely because the first failed.
6. Return success only after all three refs resolve to `S1`. Otherwise return `cloud_state_partial_publication` while preserving every successfully published newer ref.

No force updates are permitted.

A stale writer must fail on the state-ref update before it can change either watermark. A single watermark failure after the state update still leaves the other watermark as durable evidence and is automatically repairable by a later governed mutation. If both watermark writes fail after `stateRef` advanced, the lane fails closed: zero-watermark v2 cannot be automatically trusted.

Recovery never rolls any ref backward and never discards a newer validated state commit.

## Generation rules

The envelope is monotonic metadata backed by exact Git ancestry and commit-distance proof, not a standalone root of trust.

- brand-new v2 bootstrap commit: generation 1;
- v1 migration commit: legacy generation + 1;
- every normal published child: parent generation + 1 exactly;
- every trusted head must have state-side Git commit distance exactly equal to its generation;
- valid histories are not rejected solely for exceeding an arbitrary generation count;
- same-generation different SHA: reject against surviving watermarks;
- higher generation without trusted ancestry: reject;
- skipped generation: reject;
- once v2 begins, a v1 descendant: reject.

## Concurrency

Two writers may prepare children from the same trusted state, but only one may advance `stateRef` non-force. The loser fails with `cloud_state_conflict` and must not advance either watermark.

Recovery itself must be idempotent. If another process wins the same non-force watermark repair and all exact refs now resolve to the expected validated SHA, recovery may succeed; otherwise it fails closed.

After `stateRef` advances, `checkpointRef` and `witnessRef` are independent redundant acknowledgements. Either watermark may be one direct child ahead of the other, but neither may be ahead of `stateRef`, diverge from the other, or lag by more than the single in-flight state commit accepted by the bounded publication protocol.

## Required adversarial regressions

Tests must use completely new `GitHubStateStore` instances so no in-memory watermark can satisfy them:

- migrate a multi-generation legacy v1 history to a v2 child and derive generation from the exact parent rather than mutable snapshot metadata;
- a valid legacy history beyond 2,048 generations remains migratable with bounded remote requests rather than per-generation REST traversal;
- old v1 writer races migration: either the legacy writer wins first and migration restarts, or migration wins and the old writer conflicts; a v1 child is never accepted after migration;
- publish N+1, force `stateRef` back to N, delete `checkpointRef`, keep `witnessRef` at N+1: fresh process rejects rollback;
- symmetric loss of `witnessRef` with `checkpointRef` intact also rejects rollback;
- both watermarks missing while `stateRef` is already v2 fails closed;
- divergent higher-generation history is rejected;
- same generation with a different SHA is rejected;
- a child whose generation skips the parent is rejected even when all three refs are forced to agree on it;
- a superficially valid v2 child is rejected if an older v2 ancestor makes the state-side commit distance inconsistent with its generation;
- wrong `statePath` or derived ref binding cannot satisfy another store;
- explicit state tags that resemble old watermark suffixes cannot collide with the reserved checkpoint/witness namespaces;
- the two reserved namespace root names themselves are rejected as explicit state tags;
- interruption before state-ref publication leaves prior authority intact;
- failure of checkpoint publication still attempts witness publication; the surviving witness permits safe later repair;
- failure of witness publication leaves checkpoint evidence and permits safe later repair;
- if both watermark publications fail after state publication, normal readers fail closed rather than recreating trust;
- concurrent writers from the same snapshot yield one winner and one conflict;
- concurrent recovery of the same partial publication is idempotent;
- refs for `self`, `callflow`, and `website-pilot` cannot satisfy another lane's validation;
- exact-SHA content reads are retained and ordinary loads/preflight perform zero writes.

## Merge gates

Implementation remains blocked until the exact implementation SHA passes full tests, typecheck, lint, build, prepared runtime image, real Docker boundary, and a fresh independent adversarial review.

Any unresolved P1/P2 authority, rollback, fork, generation, mixed-version, TOCTOU, lane-isolation, state-path/ref-binding, scope or secret-boundary finding blocks merge. The final implementation PR for #182 must contain only the paths explicitly authorized by that issue.
