# Cloud state v2 protocol

Issue: #180

This document defines the durable authority model used by the Cloud State v2 implementation for #182. It does not widen execution, merge, deploy, model, secret, or communication authority.

## Durable refs per lane

Each lane owns three movable refs plus an append-only generation history namespace in the same repository:

- `stateRef`: the configured lane state tag.
- `checkpointRef`: `agent-cloud-state-v2-checkpoints/<stateTag>`.
- `witnessRef`: `agent-cloud-state-v2-witnesses/<stateTag>`.
- `historyRef(G)`: `agent-cloud-state-v2-history/<stateTag>/<G>` for generation `G`.

`checkpointRef` and `witnessRef` are redundant movable acknowledgements. `historyRef(G)` is the durable monotonic authority: it is created exactly once for a generation and the implementation never PATCHes, force-updates, or deletes it. A generation receipt binds one generation number to one exact state commit SHA. A competing same-generation candidate therefore cannot become authoritative after another candidate has claimed that receipt.

The three namespace roots are reserved state-tag names because Git cannot contain both a ref and child refs beneath the same path:

- `agent-cloud-state-v2-checkpoints`
- `agent-cloud-state-v2-witnesses`
- `agent-cloud-state-v2-history`

Configured state tags keep the existing grammar that excludes `/`. The store derives all durable ref names and accepts no caller-selected checkpoint, witness, or history namespace.

Process memory is never authoritative. A completed publication leaves `stateRef`, `checkpointRef`, and `witnessRef` on the same exact state commit, while `historyRef(G)` permanently records that commit for generation `G`.

## Envelope binding

Every v2 envelope binds:

- repository;
- lane id;
- state path;
- state tag;
- derived checkpoint and witness tags;
- exact `lineageBaseSha`;
- exact `lineageBaseGeneration`;
- current generation;
- state hash;
- validated state ownership and secret boundaries.

State content is always read by exact commit SHA. A moving ref is never used as the content identity.

## Legacy v1 migration boundary

Cloud State v1 had no independent durable monotonic authority. A fresh process cannot prove retrospectively that a v1 tag was never force-moved to an older but otherwise valid v1 ancestor. Walking the whole v1 history would therefore be expensive without proving the missing historical monotonic fact.

Migration treats the exact v1 `stateRef` SHA that wins the publication race as the one-time legacy trust boundary:

- `lineageBaseSha` = that exact v1 head SHA;
- `lineageBaseGeneration` = that v1 envelope generation;
- the first v2 child generation = legacy generation + 1.

This preserves real lanes whose inherited generation counter does not equal current Git distance from `main`.

The migration write is the one deliberate ordering exception: it first advances `stateRef` non-force from the exact v1 head to the v2 migration child, then creates the first v2 history receipt. This prevents a losing migration writer from claiming the generation receipt before it has won the v1 state-ref race. A crash in that narrow interval is recoverable only through governed `repair:true`: ordinary reads remain write-free and fail closed on the missing receipt.

## Immutable generation receipts

For established v2, publication is receipt-first:

1. Validate the current exact state and its complete v2 lineage.
2. Re-read the movable refs and require the validated snapshot to remain current.
3. Derive generation `G+1` only from the exact parent envelope.
4. Create the new state commit `S1` with exactly one parent, `S0`.
5. Create `historyRef(G+1) -> S1` with GitHub's create-ref operation.
6. Never PATCH or delete that history ref.
7. Only after the receipt exists, advance `stateRef -> S1` non-force.
8. Advance `checkpointRef` and `witnessRef` independently, non-force.
9. Return success only when the new state receipt exists and all three movable refs resolve to `S1`.

If two stale writers prepare different children for the same generation, only one can create the deterministic generation receipt. The loser fails before it can advance `stateRef`.

If a crash occurs after receipt creation but before `stateRef` moves, the receipt is durable evidence of the intended next state. Ordinary reads report rollback/partial publication and perform no writes. Governed repair validates the receipt child and its full lineage before advancing the movable refs; it never rolls anything backward.

## Fresh-process rollback and fork resistance

A fresh process does not trust agreement among the three movable refs by itself.

For a v2 state at generation `G` and SHA `S`:

1. `historyRef(G)` must exist and resolve exactly to `S`.
2. If `historyRef(G+1)` exists, the current movable state is behind durable authority and ordinary reads reject rollback. Governed repair may advance only to that validated direct child.
3. A same-generation different SHA is rejected because the immutable generation receipt binds the generation to the previously claimed SHA.
4. A forced joint rollback of `stateRef`, `checkpointRef`, and `witnessRef` is still detected when the next-generation receipt survives.
5. Missing checkpoint and witness refs do not erase authority when the current immutable receipt is valid. Ordinary reads stay read-only; governed repair may reconstruct only the movable acknowledgements after exact validation.

The implementation never uses a numerically higher generation as a substitute for exact SHA and ancestry proof.

## Complete v2 lineage validation without per-generation REST traffic

The r3 `ahead_by` shortcut is not authoritative and is not used to prove v2 lineage. A head can have the expected commit distance while hiding a merge or malformed intermediate envelope.

A trusted v2 head is instead validated through paginated GitHub GraphQL `Commit.history`, with the state path bound into the query. Validation walks from the exact head back to the persisted migration/bootstrap boundary in batches. Every returned v2 state commit must satisfy all of the following:

- exact expected SHA continuity;
- exactly one Git parent;
- exact generation decrement by one;
- valid, non-truncated, non-binary state blob;
- valid JSON envelope and state hash;
- repository, lane, state-path and derived-ref bindings;
- project ownership and secret boundaries;
- unchanged `lineageBaseSha` and `lineageBaseGeneration`;
- first v2 child parents the exact lineage base.

Pagination is fail-closed. Missing nodes, malformed cursors, repeated cursors, truncated blobs, incomplete history, hidden merges, missing parents, skipped generations, or malformed intermediate envelopes all reject the lineage.

This changes network complexity from roughly two REST calls per historical generation to one GraphQL page per batch plus bounded exact-SHA/ref checks. The adversarial suite constructs an established 2,050-generation v2 history and requires complete validation to remain below 1,000 total fake GitHub requests. Legacy migration beyond 2,048 generations remains bounded separately because v1 is treated as an explicit migration trust boundary.

A process may cache a lineage head only after that exact immutable commit lineage has validated successfully. The cache key is the exact commit SHA; commit contents and ancestry addressed by SHA cannot change inside Git.

## Bootstrap lineage base

For a brand-new v2 lane:

- generation 1 parents the exact configured base-branch SHA observed for bootstrap;
- `lineageBaseGeneration` is `0`;
- `lineageBaseSha` is that exact base SHA.

On later validation, the persisted bootstrap base must still be identical to or an ancestor of the configured base branch. A rewritten base history fails closed instead of silently rebasing durable state onto unrelated history.

For v1 migration, the exact v1 migration head is the lineage base and its exact v1 envelope/generation must remain valid.

## Read invariant

Ordinary `load()` and preflight reads perform zero writes.

A fresh read follows these rules:

1. Read `stateRef`, `checkpointRef`, and `witnessRef`.
2. If all are absent, inspect generation-1 history receipt. If none exists, the lane is genuinely empty. If a bootstrap receipt exists without movable refs, ordinary read fails partial publication; governed repair may recover it only after full validation.
3. If `stateRef` is absent while a movable watermark exists, fail partial publication.
4. A v1 `stateRef` with no v2 durable evidence is eligible only for one-time migration on a governed write.
5. If a v1 state has a valid next-generation v2 receipt, migration has already progressed; ordinary read fails partial publication and governed repair may advance to that exact validated child.
6. A v2 `stateRef` must match its current generation receipt.
7. A surviving next-generation receipt is rollback evidence. Ordinary read rejects; governed repair may advance one validated direct generation.
8. The complete v2 lineage of the current authoritative state is validated in batches.
9. Checkpoint/witness disagreement is allowed only for the single in-flight direct parent/child publication edge. Divergence or larger gaps fail closed.
10. Missing checkpoint/witness acknowledgements may be repaired only under `repair:true` after immutable receipt and lineage validation.
11. Exact-SHA content reads are mandatory throughout.

Recovery never rolls a ref backward and never discards a newer validated receipt.

## Crash recovery cases

The protocol explicitly handles:

- bootstrap receipt created before the first `stateRef` update;
- established-v2 receipt created before `stateRef` update;
- v1 migration state update completed before first v2 receipt creation;
- checkpoint publication failure while witness succeeds;
- witness publication failure while checkpoint succeeds;
- both movable watermark publications failing after receipt/state publication;
- two processes concurrently attempting the same repair.

A recovery path re-reads refs before mutation and uses non-force updates. If another process has changed the expected pre-state, recovery conflicts rather than guessing.

## Generation rules

- brand-new v2 bootstrap: generation 1, base generation 0;
- v1 migration: exact legacy generation + 1;
- every established v2 child: exact parent generation + 1;
- every v2 descendant preserves the same lineage base SHA and generation;
- valid history has no arbitrary generation-count cutoff;
- skipped generation: reject;
- hidden merge: reject;
- malformed intermediate envelope: reject;
- lineage-base rewrite: reject;
- same-generation sibling: reject against the existing receipt;
- v1 descendant after v2 durable authority begins: reject.

## Concurrency

For established v2, the deterministic create-only next-generation receipt serializes competing writers before movable state publication. For migration from v1, the exact non-force state-ref transition serializes the one-time migration before its first receipt is created.

Checkpoint and witness refs remain redundant operational acknowledgements, not the ultimate monotonic authority. They are never force-updated. History receipts are never PATCHed or deleted by the implementation.

## Required adversarial regressions

The implementation tests include fresh-store cases for:

- multi-generation v1 migration and inherited generation offsets;
- legacy histories beyond 2,048 generations with bounded traffic;
- complete established v2 history of 2,050 generations below the GitHub request cliff;
- forced rollback with either movable witness surviving;
- forced joint rollback of all three movable refs while a newer receipt survives;
- same-generation sibling despite all movable refs being forced to it;
- two competing candidate commits for one next-generation receipt;
- skipped generation with forged aligned movable refs and forged head receipt;
- malformed historical bootstrap with aligned refs and forged head receipt;
- hidden two-parent merge in an intermediate v2 commit;
- malformed intermediate envelope beneath a valid-looking head;
- lineage-anchor rewrite;
- divergent higher-generation history;
- mixed v1/v2 downgrade attempts;
- bootstrap receipt before state-ref publication;
- receipt-first crash before established-v2 state-ref publication;
- v1 migration crash after state publication and before receipt creation;
- checkpoint/witness partial publication and reconstruction;
- concurrent recovery;
- lane/ref/path isolation;
- reserved checkpoint/witness/history namespace roots;
- exact-SHA reads and zero-write ordinary loads.

## Merge gates

The exact implementation SHA must pass the complete CI gate: tests, real Chrome/CDP Browser QA smoke, adversarial Chrome smoke, typecheck, lint, build, prepared Node/pnpm runtime image, and real Docker execution boundary.

It must then receive a fresh independent adversarial review on frozen exact bytes with zero unresolved P1/P2 findings. Any authority, rollback, fork, generation, lineage, mixed-version, TOCTOU, lane-isolation, path/ref-binding, request-budget, scope, or secret-boundary P1/P2 blocks merge.

The implementation PR remains restricted to the three paths authorized by #182:

- `src/cloud-state.js`
- `test/cloud-state.test.js`
- `docs/CLOUD_STATE_V2_PROTOCOL.md`

No merge, deployment, or production authority is added by this protocol.