# Cloud state v2 protocol

Issue: #180

This document fixes the authority model before implementation. It does not widen execution, merge, deploy, model, secret, or communication authority.

## Durable refs per lane

Each lane owns three refs in the same repository:

- `stateRef`: the existing configured lane state tag. It points at the newest published state commit.
- `checkpointRef`: a lane-specific durable watermark.
- `witnessRef`: a second independent lane-specific durable watermark.

Process memory is never authoritative. A completed publication leaves all three refs at the same exact state commit SHA.

The two watermark refs are redundant on purpose: loss or deletion of one watermark must not erase the cross-process monotonic proof carried by the other. If both watermarks are unavailable after v2 has begun, the store fails closed rather than re-trusting `stateRef`.

All v2 envelopes are bound to repository, lane id, state path, state ref name, checkpoint ref name, witness ref name, generation and state hash.

## One-time legacy v1 migration

The configured `stateRef` already contains the real v1 durable history. Migration must not keep an arbitrary v1 head permanently eligible for bootstrap recovery.

When `stateRef` is v1 and both watermark refs are absent:

1. Read the v1 state by exact commit SHA and validate the complete v1 parent chain, generation continuity, repository/lane ownership, state hash, secret boundaries and base ancestry.
2. Re-read all refs and require the same migration pre-state.
3. Create a new v2 migration commit whose parent is exactly the validated v1 head, whose logical state is unchanged, and whose generation is exactly parent generation + 1.
4. Advance `stateRef` non-force to the v2 migration commit.
5. Create `checkpointRef` at that same commit.
6. Create `witnessRef` at that same commit.
7. Return success only after all three refs resolve to the exact v2 migration SHA.

If an old v1 writer wins the state-ref race before step 4, migration must conflict and restart from the new exact v1 head. Once `stateRef` has advanced to a v2 commit, an old v1 writer holding the previous v1 parent cannot non-force advance the ref. A v1 descendant must never be accepted after either watermark exists or v2 migration has begun.

## Read invariant

A fresh process reads all refs by exact SHA before reading any state content.

Let `S` be `stateRef`, `C` be `checkpointRef`, and `W` be `witnessRef`.

1. If `S`, `C` and `W` are all absent, bootstrap from the configured base branch.
2. If `S` is absent while either watermark exists, fail closed as partial/corrupt publication.
3. If `S` is v1 and both watermarks are absent, only the one-time legacy migration protocol above is allowed.
4. If `S` is v2 and both watermarks are absent, fail closed. Never reinterpret it as first migration.
5. If exactly one watermark is absent, the surviving watermark remains authoritative. Reconstruct the missing watermark only after exact-SHA envelope validation, ancestry proof, generation continuity and a fresh ref re-check.
6. If both watermarks exist, they must be mutually consistent with the publication order and Git history. A watermark or state ref that is an ancestor of a newer trusted watermark is rollback evidence, not a reason to move the trusted watermark backward.
7. `stateRef` may be ahead of one or both watermarks only as a valid descendant produced by an interrupted publication. Validate every traversed edge: each child generation must equal parent generation + 1 and every v2 envelope must retain the same repository/lane/path/ref bindings.
8. If neither side is ancestor of the other, reject `cloud_state_history_fork`.
9. State content is always read by exact commit SHA, never through a moving tag.
10. Even when `S == C == W`, validate the current v2 commit against its exact parent (or equivalent trusted-history proof). Matching refs alone never authorize a skipped generation or malformed lineage.

A numerically higher generation never substitutes for ancestry proof.

## Write protocol

Given a validated snapshot whose exact state SHA is `S0` and both durable watermarks resolve to `S0`:

1. Re-read all three refs immediately before publication and require them to still match the validated snapshot/recovery state.
2. Re-read the exact trusted parent envelope at `S0` and derive the next generation from it. Caller-supplied or mutable snapshot generation is never authoritative.
3. Create blob, tree and v2 state commit `S1` with parent exactly `S0` (or the configured base commit for a brand-new lane).
4. Publish `stateRef -> S1` with a non-force update.
5. Publish `checkpointRef -> S1` with a non-force update.
6. Publish `witnessRef -> S1` with a non-force update.
7. Return success only after all three refs resolve to `S1`.

No force updates are permitted.

A stale writer must fail on the first ref it can no longer advance. If publication stops after step 4 or 5, a fresh process may recover only by proving the exact descendant history from the surviving watermark(s). Recovery never rolls any ref backward and never discards a newer validated state commit.

## Generation rules

The envelope is monotonic metadata backed by exact Git ancestry, not a standalone root of trust.

- brand-new v2 bootstrap commit: generation 1;
- v1 migration commit: legacy generation + 1;
- every valid child: parent generation + 1 exactly;
- same-generation different SHA: reject;
- higher generation without trusted ancestry: reject;
- skipped generation: reject;
- once v2 begins, a v1 descendant: reject.

## Concurrency

Two writers may prepare children from the same trusted state, but only one may advance `stateRef` non-force. The loser fails with `cloud_state_conflict` and must not advance either watermark.

Recovery itself must be idempotent. If another process wins the same non-force watermark repair and all exact refs now resolve to the expected validated SHA, the recovery may succeed; otherwise it fails closed.

The valid interrupted-publication prefixes are bounded by the fixed order `stateRef -> checkpointRef -> witnessRef`. States that require a watermark to be ahead of `stateRef`, or `witnessRef` ahead of `checkpointRef`, are not normal publication prefixes and must not be silently normalized.

## Required adversarial regressions

Tests must use completely new `GitHubStateStore` instances so no in-memory watermark can satisfy them:

- migrate a multi-generation legacy v1 history to a v2 child without changing logical state;
- old v1 writer races migration: either the legacy writer wins first and migration restarts, or migration wins and the old writer conflicts; a v1 child is never checkpointed after migration begins;
- publish N+1, force `stateRef` back to N, delete `checkpointRef`, keep `witnessRef` at N+1: fresh process rejects rollback;
- symmetric loss of `witnessRef` with `checkpointRef` intact also rejects rollback;
- both watermarks missing while `stateRef` is already v2 fails closed;
- divergent higher-generation history is rejected;
- same generation with a different SHA is rejected;
- a child whose generation skips the parent is rejected even when all three refs are forced to agree on it;
- mutating `snapshot.generation` cannot influence the persisted next generation;
- wrong `statePath`, state ref name, checkpoint ref name or witness ref name cannot satisfy another store;
- interruption before state-ref publication leaves prior authority intact;
- interruption after state-ref publication is recoverable without rollback;
- interruption after checkpoint publication but before witness publication is recoverable without rollback;
- concurrent writers from the same snapshot yield one winner and one conflict;
- concurrent recovery of the same partial publication is idempotent;
- refs for `self`, `callflow`, and `website-pilot` cannot satisfy another lane's validation;
- exact-SHA content reads are retained.

## Merge gates

Implementation remains blocked until the exact implementation SHA passes full tests, typecheck, lint, build, prepared runtime image, real Docker boundary, and a fresh independent adversarial review.

Any unresolved P1/P2 authority, rollback, fork, generation, mixed-version, TOCTOU, lane-isolation, state-path/ref-binding, scope or secret-boundary finding blocks merge. The final implementation PR for #182 must contain only the paths explicitly authorized by that issue.
