# Cloud state v2 protocol

Issue: #180

This document fixes the authority model before implementation. It does not widen execution, merge, deploy, model, secret, or communication authority.

## Durable refs per lane

Each lane owns three refs in the same repository:

- `stateRef`: the existing lane state tag. It points at the newest published state commit.
- `checkpointRef`: a lane-specific trusted checkpoint tag. It points at the newest state commit that a completed publication has durably acknowledged.
- `initializationRef`: an immutable lane-specific initialization marker. It records that checkpointing has already been established at least once and prevents a missing checkpoint from being mistaken for first-time bootstrap or legacy migration.

The checkpoint ref is the cross-process monotonic watermark. Process memory is never authoritative. The initialization marker is not a substitute for the latest checkpoint; it is a durable guard against re-entering bootstrap/migration after initialization has already succeeded.

All refs are lane-specific. V2 envelopes bind repository, lane id, state tag, checkpoint tag, exact state path and generation.

## Read invariant

A fresh process reads the durable refs by exact SHA before reading state content.

Let `S` be `stateRef`, `C` be `checkpointRef`, and `I` be `initializationRef`.

1. If `S`, `C`, and `I` are all absent, bootstrap from the configured base branch.
2. If `C` exists and `S` is absent, fail closed as partial/corrupt publication.
3. If `S` exists and `C` is absent while `I` exists, fail closed as `cloud_state_checkpoint_missing`; this is not first-time bootstrap or migration.
4. If `S` exists and both `C` and `I` are absent, accept only a genuine first bootstrap or legacy-v1 migration after validating the complete envelope and commit ancestry; then create `C` optimistically at `S` and establish `I`.
5. If both `S` and `C` exist, require `S == C` or prove with the Git commit graph that `S` is a descendant of `C`.
6. If `S` is an ancestor of `C`, reject `cloud_state_rollback`.
7. If neither is ancestor of the other, reject `cloud_state_history_fork`.
8. Validate the state file by exact commit SHA, never by a moving ref. Validate repository, lane, state path, generation, state hash, ownership and secret boundaries.
9. Even when `S == C`, validate that the current generation is exactly one more than its state parent (or generation 1 rooted in the configured base history).
10. When `S` is a valid descendant of `C`, treat this as an interrupted checkpoint publication. Recovery may advance `C` to `S` only with a non-force optimistic ref update after all validation succeeds.
11. Once `C` exists, ensure `I` exists and is equal to or an ancestor of the trusted checkpoint. `I` is never advanced during ordinary state writes.

A numerically higher generation never substitutes for ancestry proof.

## Write protocol

Given a validated snapshot whose exact state SHA is `S0` and trusted checkpoint is `C0`:

1. Re-read and validate durable state before publication. The caller-provided generation is never authoritative.
2. Require the caller snapshot refs and generation to match the validated durable snapshot.
3. Derive the new generation as durable parent generation + 1.
4. Create blob, tree and state commit `S1` with parent exactly `S0` (or the configured base commit for first bootstrap).
5. Publish `stateRef -> S1` with a non-force update. A stale writer must receive a conflict.
6. Publish `checkpointRef -> S1` with a non-force update from `C0`.
7. Return success only after both refs resolve to `S1` and `initializationRef` is present and valid.

No force updates are permitted.

If state-ref publication fails, nothing authoritative changed. If checkpoint publication or final verification fails, return an explicit partial-publication error. A later fresh process may recover only through the read invariant above; it must never roll `stateRef` backward or discard a newer state commit.

## Initialization and legacy migration

The initialization marker exists specifically to prevent bootstrap replay.

- On a truly empty store, the first successful checkpoint publication establishes `initializationRef`.
- A legacy v1 history may be migrated only while both `checkpointRef` and `initializationRef` are absent and the full legacy state chain validates.
- After a checkpoint has ever been established, deleting `checkpointRef` cannot make an older v1 or v2 state look like a fresh bootstrap: the surviving initialization marker forces a closed failure.
- If checkpoint publication succeeded but initialization-marker creation was interrupted, a later process may establish the missing marker only from the still-present trusted checkpoint.

The initialization marker does not recover a missing latest checkpoint by guessing. Recovery from a genuinely lost checkpoint requires explicit trusted evidence; automatic recovery is limited to validated partial publication where the prior checkpoint still exists.

## Generation rules

The envelope remains monotonic metadata, not the root of trust.

- bootstrap state commit: generation 1;
- a valid child must have generation exactly parent generation + 1;
- write generation is derived from the durable parent, never from mutable caller state;
- same-generation different SHA is rejected;
- a higher-generation commit without ancestry from the trusted checkpoint is rejected;
- a descendant with a skipped generation is rejected;
- an agreed state/checkpoint head with an invalid parent-generation relationship is rejected.

## Concurrency

Two writers may prepare children from the same `S0`, but only one may advance `stateRef` non-force. The loser fails with `cloud_state_conflict` and must not advance the checkpoint. Recovery cannot convert a divergent child into accepted history. Concurrent recovery of the same already-validated checkpoint is idempotent only when the final observed refs resolve to the exact validated SHA.

## Required adversarial regressions

Tests must use completely new `GitHubStateStore` instances so no in-memory watermark can satisfy them:

- A writes N+1; state ref is forced back to N while checkpoint remains N+1; B rejects rollback.
- A writes N; a divergent N+1 is presented; B rejects the fork even if its generation is larger.
- same generation with a different SHA is rejected.
- legitimate descendant N+1 is accepted by a fresh process.
- a caller-mutated snapshot generation cannot create a skipped generation.
- agreed refs still reject an externally forged generation discontinuity.
- interruption after state-ref publication but before checkpoint publication fails the writer and is safely recovered by a fresh process without rollback.
- interruption before state-ref publication leaves prior state intact.
- deleting the checkpoint after initialization cannot re-enter bootstrap or legacy migration.
- legacy v1 migration establishes durable initialization evidence so an older v1 ancestor cannot later reset the watermark.
- a v2 envelope copied to a different configured state path is rejected.
- two concurrent writers from the same snapshot yield one success and one conflict.
- state/checkpoint/initialization namespaces for `self`, `callflow`, and `website-pilot` cannot satisfy another lane's validation.
- exact-SHA content reads are retained.

## Merge gates

Implementation remains blocked until the exact implementation SHA passes full tests, typecheck, lint, build, prepared runtime image, real Docker boundary, and an independent adversarial review. Any P1/P2 authority, rollback, fork, TOCTOU, lane-isolation or secret-boundary finding blocks merge.
