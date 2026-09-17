# Cloud state v2 protocol

Issue: #180

This document fixes the authority model before implementation. It does not widen execution, merge, deploy, model, secret, or communication authority.

## Durable refs per lane

Each lane owns two refs in the same repository:

- `stateRef`: the existing lane state tag. It points at the newest published state commit.
- `checkpointRef`: a new lane-specific trusted checkpoint tag. It points at the newest state commit that a completed publication has durably acknowledged.

The checkpoint ref is the cross-process watermark. Process memory is never authoritative.

Both refs are lane-specific and are bound to repository, lane id, state path and envelope generation.

## Read invariant

A fresh process reads both refs by exact SHA before reading state content.

Let `S` be `stateRef` and `C` be `checkpointRef`.

1. If neither exists, bootstrap from the configured base branch.
2. If `C` exists and `S` is absent, fail closed as partial/corrupt publication.
3. If `S` exists and `C` is absent, accept only the bootstrap recovery case after validating the complete state envelope and commit ancestry; then create `C` optimistically at `S`.
4. If both exist, require `S == C` or prove with the Git commit graph that `S` is a descendant of `C`.
5. If `S` is an ancestor of `C`, reject `cloud_state_rollback`.
6. If neither is ancestor of the other, reject `cloud_state_history_fork`.
7. Validate the state file by exact commit SHA, never by a moving ref. Validate repository, lane, generation, state hash, ownership and secret boundaries.
8. When `S` is a valid descendant of `C`, treat this as an interrupted checkpoint publication. Recovery may advance `C` to `S` only with a non-force optimistic ref update after all validation succeeds.

A numerically higher generation never substitutes for ancestry proof.

## Write protocol

Given a validated snapshot whose exact state SHA is `S0` and trusted checkpoint is `C0`:

1. Re-read both refs immediately before publication and require them to still match the validated snapshot/recovery state.
2. Create blob, tree and state commit `S1` with parent exactly `S0` (or the configured base commit for first bootstrap).
3. Publish `stateRef -> S1` with a non-force update. A stale writer must receive a conflict.
4. Publish `checkpointRef -> S1` with a non-force update from `C0`.
5. Return success only after both refs resolve to `S1`.

No force updates are permitted.

If step 3 fails, nothing authoritative changed. If step 4 or final verification fails, return an explicit partial-publication error. A later fresh process must recover only through the read invariant above; it must never roll `stateRef` backward or discard `S1`.

## Generation rules

The envelope remains monotonic metadata, not the root of trust.

- bootstrap state commit: generation 1;
- a valid child must have generation exactly parent generation + 1;
- same-generation different SHA is rejected;
- a higher-generation commit without ancestry from the trusted checkpoint is rejected;
- a descendant with a skipped generation is rejected.

## Concurrency

Two writers may prepare children from the same `S0`, but only one may advance `stateRef` non-force. The loser fails with `cloud_state_conflict` and must not advance the checkpoint. Recovery cannot convert a divergent child into accepted history.

## Required adversarial regressions

Tests must use completely new `GitHubStateStore` instances so no in-memory watermark can satisfy them:

- A writes N+1; state ref is forced back to N while checkpoint remains N+1; B rejects rollback.
- A writes N; a divergent N+1 is presented; B rejects the fork even if its generation is larger.
- same generation with a different SHA is rejected.
- legitimate descendant N+1 is accepted by a fresh process.
- interruption after state-ref publication but before checkpoint publication fails the writer and is safely recovered by a fresh process without rollback.
- interruption before state-ref publication leaves prior state intact.
- two concurrent writers from the same snapshot yield one success and one conflict.
- state/checkpoint refs for `self`, `callflow`, and `website-pilot` cannot satisfy another lane's validation.
- exact-SHA content reads are retained.

## Merge gates

Implementation remains blocked until the exact implementation SHA passes full tests, typecheck, lint, build, prepared runtime image, real Docker boundary, and an independent adversarial review. Any P1/P2 authority, rollback, fork, TOCTOU, lane-isolation or secret-boundary finding blocks merge.
