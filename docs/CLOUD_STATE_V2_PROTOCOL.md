# Cloud State v2 protocol — r6 bounded epoch authority

## Purpose

Cloud State v2 provides durable per-lane state for cloud workers without trusting process-local memory or mutable Git refs as monotonic authority.

The protocol is intentionally fail-closed. It must reject rollback, forks, malformed history, cross-lane substitution, secret-bearing state, and publication states that cannot be proven after a crash.

r6 replaces the rejected r5 global status ledger. r5 failed for two reasons:

1. a pre-CAS intent could not prove that the state-ref CAS actually happened;
2. repeated scans of a single ever-growing status ledger became operationally unsafe.

r6 uses **post-CAS canonical authority** and **bounded epochs of 256 generations**.

## Mutable refs

Each lane owns three movable Git tag refs:

- state ref: the configured lane tag;
- checkpoint ref: `agent-cloud-state-v2-checkpoints/<stateTag>`;
- witness ref: `agent-cloud-state-v2-witnesses/<stateTag>`.

These refs are operational pointers only. They are not monotonic roots of trust because `contents: write` can move or remove them outside this implementation.

All supported updates are non-force.

## Immutable status root

Epoch metadata is written as GitHub commit statuses attached to the verified parentless repository root:

`b4f3b2e76e24be58d241227850a5d48ea19c2ea8`

Before any Cloud State status is trusted, that exact Git commit must exist and have zero parents.

GitHub commit statuses are append-only through the API surface used by the worker. Conflicting evidence cannot erase older evidence and therefore fails closed.

## Lane digest

Every lane derives a 128-bit lowercase digest from the canonical tuple:

- repository;
- lane id;
- state path;
- state tag;
- checkpoint tag;
- witness tag.

All epoch contexts include that digest. Evidence from another lane is ignored and cannot satisfy this lane.

## Epochs

Epoch size is fixed at **256 generations**.

For generation `G`:

`epoch = floor((G - 1) / 256)`

An epoch may begin in the middle of its numerical bucket during v1 migration. Example: a legacy generation 280 migrates to v2 generation 281, so the first v2 epoch is epoch 1 and begins at generation 281.

Each epoch has:

- one immutable registration on the repository root;
- zero or one immutable seal on the repository root;
- canonical generation statuses attached to that epoch's immutable anchor commit.

### Registration

Context:

`agent-cloud-state-v2/<laneDigest>/e/<epoch>`

Description:

`a=<anchorSha>;b=<baseGeneration>;s=<startGeneration>`

Required invariants:

- `startGeneration = baseGeneration + 1`;
- `epoch(startGeneration)` equals the context epoch;
- first epoch anchor is the bootstrap base SHA or exact v1 migration head;
- every later epoch anchor equals the previous epoch seal state SHA;
- every later epoch begins exactly one generation after the previous seal.

A registration is structural metadata only. **It does not authorize a state commit.**

Creating a registration before the state CAS is safe because an orphan registration has no canonical authority.

### Canonical authority

Authority statuses are written on the epoch's anchor commit.

Context:

`agent-cloud-state-v2/<laneDigest>/a/<epoch>/g/<generation>`

Description:

`s=<stateSha>;p=<parentSha>`

Authority is valid only when:

- the status is `success`;
- there is no target URL;
- generation belongs to the registered epoch and is within its range;
- the first generation parents the epoch anchor;
- later generations parent the preceding canonical state;
- there are no conflicting records for one generation.

Most importantly, the canonical authority status is appended **only after a successful, proven non-force state-ref CAS**.

There is no pre-CAS intent authority in r6.

### Seal

A full epoch is sealed before publication enters the next epoch.

Context:

`agent-cloud-state-v2/<laneDigest>/s/<epoch>`

Description:

`s=<stateSha>;g=<generation>`

The sealed generation must equal the numerical end of that epoch, for example 256, 512, 768, etc.

A seal may be written only after the complete active epoch lineage has been validated. The seal becomes the durable checkpoint for that historical epoch.

A later epoch registration must anchor exactly to the preceding seal.

## Why a pre-CAS intent is not authority

A pre-CAS record only proves that a candidate existed. It cannot prove that the writer won the state-ref election.

If a process crashes after a pre-CAS record but before the ref CAS, a separate `contents: write` actor could later move the ref to that candidate. Automatically canonicalizing from the old intent would incorrectly elevate mutable-ref authority.

r6 therefore does not use a pre-CAS intent as proof.

## Strict state-ref CAS

The authority-bearing state ref uses a strict CAS path.

The writer:

1. validates the current authoritative snapshot;
2. creates the candidate state commit;
3. performs a non-force state-ref create/update from the exact expected predecessor;
4. requires the GitHub mutation request itself to succeed;
5. re-reads the state ref and requires the exact candidate SHA;
6. only then appends canonical authority.

An uncertain/failed state-ref mutation is never converted to success merely because a later read happens to show the candidate.

Checkpoint and witness refs remain repairable operational pointers and may use ordinary forward-only recovery.

## Crash boundary after CAS

The hard boundary is:

`state CAS succeeded -> canonical status not yet written`

If the process crashes here, a future process can observe the state ref ahead of the newest canonical authority, but it cannot prove who moved that ref.

Therefore:

- ordinary read fails closed;
- `repair:true` also fails closed;
- no canonical status is synthesized;
- the lane requires explicit operator reconciliation.

This is deliberate. Availability is sacrificed rather than converting mutable ref state into durable authority.

## Bootstrap

For a brand-new lane:

- lineage base is the exact configured base-branch SHA;
- lineage base generation is 0;
- first v2 generation is 1;
- first epoch registration anchors to that base SHA.

If registration exists but no state CAS has happened, the empty lane remains readable and publication may safely retry.

If the state ref contains v2 state but no canonical authority exists, the state is an unproven advance and is rejected even with repair.

## Legacy v1 migration

v1 had no independent monotonic authority, so migration has one unavoidable trust boundary: the exact v1 state-tag head observed before the first v2 publication.

For migration:

- first epoch anchor is that exact v1 head;
- base generation is the v1 envelope generation;
- first v2 generation is legacy generation + 1;
- inherited generation offsets are preserved.

A real legacy generation must never be inferred from Git distance.

If a migration registration exists but the state ref still points to the exact registered v1 anchor, migration may retry safely.

If the state ref has advanced to v2 without canonical authority, the advance is rejected.

## Active epoch validation

Only the current active epoch requires full per-generation validation.

The newest canonical authority is validated backwards to its epoch anchor using paginated GitHub GraphQL commit history.

Every state in the active epoch must satisfy:

- exact SHA continuity;
- exactly one Git parent;
- no hidden merge;
- generation decreases by exactly one per edge;
- repository/lane/path/ref binding;
- unchanged persisted lineage base;
- valid state hash;
- project ownership boundaries;
- secret-material boundaries;
- exact matching canonical status for the generation and parent.

The first active-epoch state must parent the registered epoch anchor.

GraphQL validation is bounded to four pages of 100 commits. An epoch has at most 256 generations, so exceeding the bound is corruption or protocol drift and fails closed.

## Sealed historical epochs

A seal is written only after complete validation of that epoch.

Git commit objects and commit statuses are immutable in the authority model, so a fresh process may trust the seal as the durable checkpoint for the sealed epoch instead of replaying every historical generation.

This makes read/write cost depend on the active epoch rather than total lifetime generations.

Root registrations and seals still form a contiguous chain and are all checked.

## Bounded request model

Root epoch metadata is read from the root status log with an explicit maximum of 20 pages.

The active epoch authority log is read from its anchor with an explicit maximum of four pages.

The active lineage is read with at most four GraphQL history pages.

At 2,050 generations the expected root metadata is only a small number of registrations/seals and the active epoch contains only the latest few generations.

The adversarial regression requires a fresh aligned load of 2,050 generations to remain below 30 fake-network requests.

If pagination exceeds any configured bound, the store fails closed rather than silently truncating authority evidence.

## Publication protocol

### Initial bootstrap or migration

1. read refs and epoch evidence;
2. validate the empty lane or exact v1 migration head;
3. create or reuse the exact first epoch registration;
4. create the v2 candidate commit;
5. prove strict non-force state-ref CAS success;
6. append canonical authority on the epoch anchor;
7. validate active epoch lineage;
8. advance checkpoint and witness independently, non-force;
9. verify final refs and canonical authority.

If step 5 fails or is uncertain, no authority is appended.

If step 6 fails after step 5, publication is partial and later automatic repair must not canonicalize the state.

### Established v2 in the same epoch

1. validate current canonical authority and active lineage;
2. create the direct one-parent child;
3. prove strict state-ref CAS from the exact authoritative parent;
4. append canonical authority for the child;
5. validate active lineage;
6. advance checkpoint and witness;
7. verify final pointers.

Two stale writers may create sibling commits, but only one can win the non-force state-ref CAS. The loser must not append authority.

### Epoch rollover

Before publishing the first generation of the next epoch:

1. require current authority at the exact end generation of the active epoch;
2. validate the complete active epoch;
3. append or verify the exact epoch seal;
4. append or verify the next epoch registration anchored to that seal;
5. publish the next candidate using the normal strict CAS -> authority sequence.

A crash after seal or registration but before the next state CAS is harmless. The structural metadata may be reused because it carries no new state authority.

## Read and repair

With canonical authority present:

- aligned state/checkpoint/witness refs are accepted;
- state ref behind authority is rollback;
- `repair:true` may only move a missing/behind ref forward, non-force, to canonical authority;
- state ref ahead of canonical authority is an **unproven state advance** and always fails closed;
- divergent/sibling state is a history fork;
- checkpoint/witness ahead or divergent fail closed;
- missing/behind checkpoint/witness may be repaired forward.

Joint rollback of all movable refs does not erase the immutable canonical epoch evidence.

## Exact-SHA reads

State content is always read using an exact 40-hex commit SHA, never from a mutable branch/tag name.

## Security boundaries

The protocol preserves:

- explicit project ownership;
- secret-key rejection;
- known secret-material rejection;
- state-size bounds;
- lane isolation;
- exact path/ref binding;
- no automatic merge authority;
- no production deployment authority;
- no broader communication authority.

## Required adversarial regressions

The r6 acceptance suite includes at least:

- bootstrap and v1 migration;
- inherited legacy generation offsets;
- failed state CAS creates no authority;
- bootstrap crash after CAS/before authority cannot be repaired;
- established crash after CAS/before authority cannot be repaired;
- checkpoint/witness partial publication and safe forward repair;
- joint rollback of all movable refs;
- same-generation sibling substitution;
- competing stale writers;
- conflicting authority/registration evidence;
- epoch rollover;
- orphan next-epoch registration;
- hidden two-parent merge in the active epoch;
- malformed/truncated active-epoch envelopes;
- lineage-anchor rewrite;
- lane isolation;
- exact-SHA reads;
- bounded unrelated-status pagination;
- explicit pagination fail-closed behavior;
- 2,050-generation bounded-request validation;
- lease behavior and remote state integrity.

## Acceptance gate

r6 is not mergeable until:

1. the candidate starts from current authoritative `main`;
2. changed files remain exactly:
   - `src/cloud-state.js`
   - `test/cloud-state.test.js`
   - `docs/CLOUD_STATE_V2_PROTOCOL.md`;
3. the exact candidate SHA passes full CI including:
   - tests;
   - real Chrome/CDP smoke;
   - adversarial Chrome smoke;
   - typecheck;
   - lint;
   - build;
   - prepared runtime image;
   - real Docker execution boundary;
4. a fresh frozen exact-SHA independent adversarial review reports zero unresolved P1/P2.

Issue #182 grants no automatic merge or production deployment authority.
