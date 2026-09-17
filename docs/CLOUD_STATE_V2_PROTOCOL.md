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

All v2 envelopes are bound to repository, lane id, state path, state ref name, checkpoint ref name, witness ref name, an exact lineage base SHA, lineage base generation, current generation and state hash.

## Why v1 history becomes an explicit migration boundary

Cloud State v1 had no separate durable monotonic watermark. A fresh process therefore cannot retroactively prove that the current v1 state tag was never force-moved to an older but otherwise valid ancestor. Walking every historical v1 envelope gives expensive false assurance: it can prove local shape and generation continuity, but not that the selected v1 head is the newest head that ever existed.

Migration therefore treats the exact v1 `stateRef` SHA observed at the successful publication race as the one-time trust boundary. This is explicit, durable and honest about what can be proven. Once the first v2 commit is published, the redundant v2 watermarks become the cross-process monotonic authority.

This also preserves real existing lanes whose historical generation counter may have an inherited offset relative to the current Git merge-base. Migration does not require legacy generation to equal commit distance from today's `main` branch.

## Bounded v2 lineage anchor

Every v2 envelope carries:

- `lineageBaseSha`
- `lineageBaseGeneration`

For a brand-new v2 lane, `lineageBaseSha` is the exact configured base-branch SHA used as the first state commit's parent and `lineageBaseGeneration` is `0`.

For migration from v1, `lineageBaseSha` is the exact validated v1 head SHA and `lineageBaseGeneration` is that exact v1 envelope's generation.

Every later v2 child must inherit both fields unchanged.

For a trusted v2 state SHA `S` with generation `G`, validation is bounded independently of total history length:

1. Read `S` and its envelope by exact SHA.
2. Require the exact state commit to have one parent.
3. Validate the lineage base:
   - if base generation is zero, the base SHA must remain in the configured base branch's ancestry;
   - otherwise read the base envelope by exact SHA, require v1 and require its generation to equal the persisted base generation.
4. Compare `lineageBaseSha...S` through GitHub's commit graph.
5. Require the lineage base to be an ancestor of `S` and require `ahead_by == G - lineageBaseGeneration` exactly.
6. Validate the immediate parent edge. The first v2 state must parent the lineage base exactly. Later v2 states require a v2 parent at generation `G-1` with the same immutable lineage-base fields.

The compare payload is validated fail-closed: missing, negative or non-integer `ahead_by`/`behind_by` values are invalid.

The head proof is intentionally self-contained instead of recursively trusting the `generation` field of every historical envelope. In v2, the authoritative generation of the current head is constrained by Git topology from the fixed exact lineage base. A historical envelope with malformed metadata cannot alter the current head's state hash, binding or topology-derived generation claim; if that historical commit is ever made authoritative again, its own envelope and topology invariants are checked at that time and surviving watermarks additionally reject rollback. This is what removes the O(total-history) REST walk rather than merely hiding it behind a larger cutoff.

This catches the previously demonstrated aligned-ref malformed bootstrap: a generation-2 v2 commit parented directly to a generation-0 base followed by an apparently valid generation-3 child has only two Git commits after the lineage base, so generation distance does not match and the fresh process rejects it.

The proof uses a constant number of GitHub API calls for a head regardless of whether the legacy history had 4, 280, 2,050 or far more generations. It does not impose an arbitrary history-depth cutoff.

## One-time legacy v1 migration

When `stateRef` is v1 and both watermark refs are absent:

1. Read the v1 state by exact commit SHA and validate repository/lane ownership, state hash and secret boundaries.
2. Require the exact v1 head commit to have one parent. Do not attempt an unbounded historical walk that cannot establish retroactive monotonicity anyway.
3. Re-read all refs and require the same migration pre-state.
4. Create a new v2 migration commit whose parent is exactly that v1 head and whose generation is exactly parent generation + 1.
5. Persist `lineageBaseSha` as that exact v1 head and `lineageBaseGeneration` as its exact generation.
6. Advance `stateRef` non-force to the v2 migration commit.
7. Attempt `checkpointRef` and `witnessRef` independently at that same commit. A failure of one must not prevent attempting the other.
8. Return success only after all three refs resolve to the exact v2 migration SHA; otherwise return an explicit partial-publication error.

If an old v1 writer wins the state-ref race before publication, migration conflicts and restarts from the new exact v1 head. Once `stateRef` has advanced to v2, an old v1 writer holding the previous v1 parent cannot non-force advance the ref. A v1 descendant must never be accepted after either watermark exists or v2 migration has begun.

If `stateRef` is already v2 and both watermarks are absent, the state is a hard partial publication. It must fail closed and require explicit operator recovery that preserves the newer exact state SHA; a normal read/mutation must never recreate trust automatically from `stateRef` alone.

## Read invariant

A fresh process reads all refs by exact SHA before reading any state content.

Let `S` be `stateRef`, `C` be `checkpointRef`, and `W` be `witnessRef`.

1. If `S`, `C` and `W` are all absent, bootstrap from the configured base branch.
2. If `S` is absent while either watermark exists, fail closed as partial/corrupt publication.
3. If `S` is v1 and both watermarks are absent, only the one-time legacy migration path above is eligible on a governed write; ordinary reads remain read-only.
4. If `S` is v2 and both watermarks are absent, validate enough exact-SHA evidence to classify the state, then fail closed. Never reinterpret it as first migration.
5. If exactly one watermark exists, it is the durable authority witness. `S` must be either that exact commit or one validated direct v2 child. The missing watermark may be reconstructed only during a governed repair after exact-SHA validation and a fresh ref re-check.
6. If both watermarks exist and differ, either one may be the newer direct v2 child because publication attempts them independently. Prove their exact parent/child relationship, generation +1 continuity and identical lineage-base fields, then use the newer watermark as trusted SHA. Divergent or multi-step watermark gaps fail closed.
7. A trusted v2 watermark is validated against its exact persisted lineage base even when all refs agree. Matching refs alone never authorize a skipped generation, malformed bootstrap or lineage-anchor rewrite.
8. `stateRef` may equal the newest watermark or be one validated direct v2 child ahead of it as the result of an interrupted publication. A state ref behind a surviving newer watermark is rollback evidence and is rejected.
9. If neither side is ancestor of the other, reject `cloud_state_history_fork`.
10. State content is always read by exact commit SHA, never through a moving tag.
11. Ordinary `load()`/preflight reads never mutate refs. Watermark repair occurs only on an explicitly governed mutation/recovery path.

A numerically higher generation never substitutes for ancestry proof. For v2, the generation delta must equal the Git commit distance from the immutable migration/bootstrap boundary.

## Write protocol

Given a validated snapshot whose exact state SHA is `S0` and both durable watermarks resolve to `S0` (or a legacy v1 snapshot with no watermarks):

1. Re-read all three refs immediately before publication and require them to still match the validated snapshot.
2. Re-read the exact parent envelope. For v1 migration, use that exact v1 head as the lineage base. For established v2, revalidate the bounded lineage proof and inherit its lineage-base fields unchanged.
3. Derive next generation only from the exact parent envelope. Caller-supplied snapshot generation is never authoritative.
4. Create blob, tree and v2 state commit `S1` with parent exactly `S0` (or the configured base SHA for a brand-new lane).
5. Publish `stateRef -> S1` with a non-force update.
6. Attempt `checkpointRef -> S1` and `witnessRef -> S1` independently with non-force updates. Do not skip the second watermark merely because the first failed.
7. Return success only after all three refs resolve to `S1`. Otherwise return `cloud_state_partial_publication` while preserving every successfully published newer ref.

No force updates are permitted.

A stale writer must fail on the state-ref update before it can change either watermark. A single watermark failure after the state update still leaves the other watermark as durable evidence and is automatically repairable by a later governed mutation. If both watermark writes fail after `stateRef` advanced, the lane fails closed: zero-watermark v2 cannot be automatically trusted.

Recovery never rolls any ref backward and never discards a newer validated state commit.

## Generation and anchor rules

The v2 envelope is monotonic metadata backed by exact Git ancestry and an immutable migration/bootstrap boundary.

- brand-new v2 bootstrap commit: generation 1, lineage base generation 0;
- v1 migration commit: legacy generation + 1, lineage base is exact legacy head;
- every later v2 child: parent generation + 1 exactly;
- every later v2 child: identical lineage base SHA and generation to its parent;
- every trusted v2 head: Git distance from lineage base equals current generation minus base generation;
- valid histories are not rejected solely for exceeding an arbitrary generation count;
- same-generation different SHA: reject against surviving watermarks;
- higher generation without trusted ancestry: reject;
- skipped generation: reject;
- lineage base rewrite: reject;
- once v2 begins, a v1 descendant: reject.

## Concurrency

Two writers may prepare children from the same trusted state, but only one may advance `stateRef` non-force. The loser fails with `cloud_state_conflict` and must not advance either watermark.

Recovery itself must be idempotent. If another process wins the same non-force watermark repair and all exact refs now resolve to the expected validated SHA, recovery may succeed; otherwise it fails closed.

After `stateRef` advances, `checkpointRef` and `witnessRef` are independent redundant acknowledgements. Either watermark may be one direct child ahead of the other, but neither may be ahead of `stateRef`, diverge from the other, rewrite the lineage base, or lag by more than the single in-flight state commit accepted by the bounded publication protocol.

## Required adversarial regressions

Tests must use completely new `GitHubStateStore` instances so no in-memory watermark can satisfy them:

- migrate a multi-generation legacy v1 history to a v2 child and persist the exact migration head/generation as immutable lineage base;
- preserve migration for a valid legacy history beyond 2,048 generations with bounded remote requests rather than per-generation REST traversal;
- preserve migration when legacy generation has an inherited non-zero offset relative to base-branch commit distance;
- old v1 writer races migration: either the legacy writer wins first and migration restarts, or migration wins and the old writer conflicts; a v1 child is never accepted after migration;
- publish N+1, force `stateRef` back to N, delete `checkpointRef`, keep `witnessRef` at N+1: fresh process rejects rollback;
- symmetric loss of `witnessRef` with `checkpointRef` intact also rejects rollback;
- both watermarks missing while `stateRef` is already v2 fails closed;
- divergent higher-generation history is rejected;
- same generation with a different SHA is rejected;
- a child whose generation skips the parent is rejected even when all three refs are forced to agree on it;
- the previously demonstrated malformed generation-2 bootstrap followed by an apparently valid generation-3 child is rejected even with aligned refs;
- a v2 child cannot rewrite its lineage base;
- wrong `statePath` or derived ref binding cannot satisfy another store;
- explicit state tags that resemble old watermark suffixes cannot collide with reserved checkpoint/witness namespaces;
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
